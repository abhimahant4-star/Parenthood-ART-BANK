const router = require("../http/router").Router();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const User = require("../models/User");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { scopeId, scopeNameKey, hasHospitalScopeNameCollision } = require("../utils/scopeIds");
const { withTransaction } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");

async function lockNamedScopeRegistry(session) {
  const locked = await User.findOneAndUpdate(
    { role: "SUPER_ADMIN", active: true },
    { $inc: { scopeRegistryVersion: 1 } },
    { new: true, session, sort: { _id: 1 } }
  );
  if (!locked) {
    const error = new Error("No active Super Admin is available to serialize hospital scope assignment");
    error.code = "HOSPITAL_SCOPE_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function namedHospitalScopeCollides(session, proposed, excludeUserId) {
  await lockNamedScopeRegistry(session);
  const filter = { role: "HOSPITAL_USER", hospitalId: proposed.hospitalId };
  if (excludeUserId) filter._id = { $ne: excludeUserId };
  const existing = await User.find(filter).select("hospitalId hospitalName centreId centreName").session(session).lean();
  return hasHospitalScopeNameCollision(existing, proposed);
}

// =====================================================
// GET ALL USERS
// Super Admin only
// =====================================================

router.get(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
      const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
      const filter = {};
      const [users, total] = await Promise.all([User.find(filter)
        .select("-passwordHash -activeSessionId")
        .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit), User.countDocuments(filter)]);

      res.json({
        success: true,
        data: users,
        pagination: { skip, limit, total, hasMore: skip + users.length < total }
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch users",
        errorCode: "USERS_FETCH_ERROR"
      });
    }
  }
);

router.get("/ceos", requireAuth, allowRoles("SUPER_ADMIN"), async (req, res) => {
  try {
    const ceos = await User.find({ role: "CHAIN_CEO", active: true })
      .select("name username chainId")
      .sort({ name: 1, username: 1 })
      .lean();
    return res.json({ success: true, data: ceos });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch active CEO accounts", errorCode: "CEOS_FETCH_ERROR" });
  }
});

router.post("/hospital-registration", requireAuth, allowRoles("SUPER_ADMIN"), async (req, res) => {
  const hospitalName = typeof req.body.hospitalName === "string" ? req.body.hospitalName.trim().replace(/\s+/g, " ") : "";
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const linkedCeoId = typeof req.body.linkedCeoId === "string" ? req.body.linkedCeoId.trim() : "";
  if (hospitalName.length < 2 || hospitalName.length > 160 || !username || !password) {
    return res.status(400).json({ success: false, message: "A hospital/centre name, username and password are required", errorCode: "HOSPITAL_REGISTRATION_REQUIRED" });
  }
  if (linkedCeoId && !mongoose.Types.ObjectId.isValid(linkedCeoId)) {
    return res.status(400).json({ success: false, message: "Choose a valid active CEO account or leave the hospital unlinked", errorCode: "INVALID_CEO_LINK" });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) {
    return res.status(400).json({ success: false, message: "Username must be 3-64 letters, numbers, dots, underscores or hyphens, and start with a letter or number", errorCode: "INVALID_USERNAME" });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await withTransaction(async session => {
      await lockNamedScopeRegistry(session);
      const registrations = await User.find({ role: "HOSPITAL_USER" }).select("hospitalName name").session(session).lean();
      const nameKey = scopeNameKey(hospitalName);
      if (registrations.some(item => scopeNameKey(item.hospitalName || item.name) === nameKey)) {
        const conflict = new Error("A hospital/centre account with this name is already registered");
        conflict.code = "HOSPITAL_REGISTRATION_EXISTS";
        throw conflict;
      }

      if (await User.exists({ username }).session(session)) {
        const conflict = new Error("Username already exists");
        conflict.code = "USERNAME_EXISTS";
        throw conflict;
      }
      if (linkedCeoId && !await User.exists({ _id: linkedCeoId, role: "CHAIN_CEO", active: true }).session(session)) {
        const conflict = new Error("The selected CEO account is inactive or unavailable");
        conflict.code = "INVALID_CEO_LINK";
        throw conflict;
      }
      const hospitalId = username;
      const centreId = `CENTRE-${username}`;

      const [created] = await User.create([{
        username, passwordHash, name: hospitalName, role: "HOSPITAL_USER",
        hospitalId, hospitalName, centreId, centreName: hospitalName,
        linkedCeoId: linkedCeoId || null,
        active: true, activeSessionId: null, sessionVersion: 1
      }], { session });
      await recordOperationalEvent({
        actorId: String(req.user.id), role: req.user.role, event: "HOSPITAL_REGISTERED", entityId: String(created._id),
        metadata: { hospitalId, centreId, ceoLinked: Boolean(linkedCeoId) }, ip: req.ip, session
      });
      return created;
    });
    const safeUser = user.toObject();
    delete safeUser.passwordHash;
    delete safeUser.activeSessionId;
    delete safeUser.scopeRegistryVersion;
    return res.status(201).json({ success: true, message: "Hospital account registered", data: safeUser });
  } catch (error) {
    if (error?.code === "HOSPITAL_REGISTRATION_EXISTS") {
      return res.status(409).json({ success: false, message: error.message, errorCode: error.code });
    }
    if (error?.code === "HOSPITAL_SCOPE_LOCK_UNAVAILABLE") {
      return res.status(503).json({ success: false, message: "Hospital registration is temporarily unavailable", errorCode: error.code });
    }
    if (error?.code === "USERNAME_EXISTS") {
      return res.status(409).json({ success: false, message: error.message, errorCode: error.code });
    }
    if (error?.code === "INVALID_CEO_LINK") {
      return res.status(400).json({ success: false, message: error.message, errorCode: error.code });
    }
    if (error?.code === 11000) {
      if (username) {
        return res.status(409).json({ success: false, message: "Username already exists", errorCode: "USERNAME_EXISTS" });
      }
      return res.status(409).json({ success: false, message: "A unique hospital account value could not be assigned; retry registration", errorCode: "HOSPITAL_REGISTRATION_CONFLICT" });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to register hospital account", errorCode: "HOSPITAL_REGISTRATION_ERROR" });
  }
});


// =====================================================
// CREATE USER
// Super Admin only
// =====================================================

router.post(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const {
        username,
        password,
        name,
        role,
        hospitalId,
        hospitalName,
        centreId,
        centreName,
        chainId,
        active
      } = req.body;

      if (active !== undefined && typeof active !== "boolean") {
        return res.status(400).json({ success: false, message: "active must be a boolean", errorCode: "INVALID_ACTIVE_STATUS" });
      }

      let assignedHospitalId = hospitalId, assignedCentreId = centreId;
      if (role === "HOSPITAL_USER" && Boolean(hospitalName) !== Boolean(centreName)) {
        return res.status(400).json({ success: false, message: "Full hospital and centre names must be provided together", errorCode: "HOSPITAL_SCOPE_REQUIRED" });
      }
      if (role === "HOSPITAL_USER" && hospitalName && centreName) {
        assignedHospitalId = scopeId("HOSP", hospitalName);
        assignedCentreId = scopeId("CENTRE", centreName);
      }
      if (role === "HOSPITAL_USER" && (!assignedHospitalId || !assignedCentreId)) {
        return res.status(400).json({ success: false, message: "Hospital users must be assigned a hospital and centre", errorCode: "HOSPITAL_SCOPE_REQUIRED" });
      }

      if (!username || !password || !name || !role) {
        return res.status(400).json({
          success: false,
          message: "Username, password, name and role are required",
          errorCode: "REQUIRED_FIELDS"
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const userId = new mongoose.Types.ObjectId();
      const user = await withTransaction(async session => {
        if (role === "HOSPITAL_USER" && hospitalName && centreName && await namedHospitalScopeCollides(session, {
          hospitalId: assignedHospitalId, centreId: assignedCentreId, hospitalName, centreName
        })) {
          const conflict = new Error("A different hospital or centre name already resolves to this scope ID");
          conflict.code = "HOSPITAL_SCOPE_ID_COLLISION";
          throw conflict;
        }
        const existingUser = await User.findOne({ username: username.trim() }).session(session);
        if (existingUser) {
          const conflict = new Error("Username already exists");
          conflict.code = "USERNAME_EXISTS";
          throw conflict;
        }
        const [created] = await User.create([{
          _id: userId,
          username: username.trim(),
          passwordHash,
          name,
          role,
          hospitalId: assignedHospitalId || null,
          hospitalName: hospitalName || null,
          centreId: assignedCentreId || null,
          centreName: centreName || null,
          chainId: chainId || null,
          active: active !== false,
          activeSessionId: null,
          sessionVersion: 1
        }], { session });
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "USER_CREATED", entityId: String(userId),
          metadata: {
            assignedRole: role,
            active: active !== false,
            ...(assignedHospitalId && /^[A-Za-z0-9_.:-]{1,160}$/.test(assignedHospitalId) ? { hospitalId: assignedHospitalId } : {}),
            ...(assignedCentreId && /^[A-Za-z0-9_.:-]{1,160}$/.test(assignedCentreId) ? { centreId: assignedCentreId } : {})
          },
          ip: req.ip, session
        });
        return created;
      });

      const safeUser = user.toObject();

      delete safeUser.passwordHash;
      delete safeUser.activeSessionId;
      delete safeUser.scopeRegistryVersion;

      res.status(201).json({
        success: true,
        message: "User created successfully",
        data: safeUser
      });

    } catch (error) {
      console.error(error);

      if (error?.code === "USERNAME_EXISTS" || error?.code === 11000) {
        return res.status(409).json({ success: false, message: "Username already exists", errorCode: "USERNAME_EXISTS" });
      }
      if (error?.code === "HOSPITAL_SCOPE_ID_COLLISION") {
        return res.status(409).json({ success: false, message: error.message, errorCode: "HOSPITAL_SCOPE_ID_COLLISION" });
      }
      if (error?.code === "HOSPITAL_SCOPE_LOCK_UNAVAILABLE") {
        return res.status(503).json({ success: false, message: "Hospital scope assignment is temporarily unavailable", errorCode: "HOSPITAL_SCOPE_LOCK_UNAVAILABLE" });
      }

      res.status(500).json({
        success: false,
        message: "Failed to create user",
        errorCode: "USER_CREATE_ERROR"
      });
    }
  }
);


// =====================================================
// UPDATE USER
// Super Admin only
// =====================================================

router.put(
  "/:id",
  requireAuth,
  allowRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const {
        name,
        role,
        hospitalId,
        hospitalName,
        centreId,
        centreName,
        chainId,
        active
      } = req.body;
      if (active !== undefined && typeof active !== "boolean") {
        return res.status(400).json({ success: false, message: "active must be a boolean", errorCode: "INVALID_ACTIVE_STATUS" });
      }
      const assignedHospitalId = hospitalName ? scopeId("HOSP", hospitalName) : hospitalId;
      const assignedCentreId = centreName ? scopeId("CENTRE", centreName) : centreId;
      const result = await withTransaction(async session => {
        const user = await User.findById(req.params.id).session(session);
        if (!user) return { error: { status: 404, message: "User not found", errorCode: "USER_NOT_FOUND" } };
        const previousRole = user.role;
        if ((role === "HOSPITAL_USER" || user.role === "HOSPITAL_USER") && Boolean(hospitalName) !== Boolean(centreName)) {
          return { error: { status: 400, message: "Full hospital and centre names must be provided together", errorCode: "HOSPITAL_SCOPE_REQUIRED" } };
        }

        const targetRole = role === undefined ? user.role : role;
        if (targetRole === "HOSPITAL_USER" && hospitalName && centreName && await namedHospitalScopeCollides(session, {
          hospitalId: assignedHospitalId || user.hospitalId,
          centreId: assignedCentreId || user.centreId,
          hospitalName, centreName
        }, user._id)) {
          return { error: { status: 409, message: "A different hospital or centre name already resolves to this scope ID", errorCode: "HOSPITAL_SCOPE_ID_COLLISION" } };
        }

        const scopeChanged = (role !== undefined && role !== user.role) ||
          (assignedHospitalId !== undefined && (assignedHospitalId || null) !== (user.hospitalId || null)) ||
          (assignedCentreId !== undefined && (assignedCentreId || null) !== (user.centreId || null));
        if ((role === "HOSPITAL_USER" || (role === undefined && user.role === "HOSPITAL_USER")) &&
            (!(assignedHospitalId !== undefined ? assignedHospitalId : user.hospitalId) || !(assignedCentreId !== undefined ? assignedCentreId : user.centreId))) {
          return { error: { status: 400, message: "Hospital users must be assigned a hospital and centre", errorCode: "HOSPITAL_SCOPE_REQUIRED" } };
        }

        if (name !== undefined) user.name = name;
        if (role !== undefined) user.role = role;
        if (assignedHospitalId !== undefined) user.hospitalId = assignedHospitalId || null;
        if (hospitalName !== undefined) user.hospitalName = hospitalName || null;
        if (assignedCentreId !== undefined) user.centreId = assignedCentreId || null;
        if (centreName !== undefined) user.centreName = centreName || null;
        if (chainId !== undefined) user.chainId = chainId || null;

        if (active !== undefined) {
          user.active = active;
          if (active === false) {
            user.activeSessionId = null;
            user.sessionVersion = (user.sessionVersion || 1) + 1;
          }
        }
        if (scopeChanged) {
          user.activeSessionId = null;
          user.sessionVersion = (user.sessionVersion || 1) + 1;
        }

        await user.save({ session });
        const metadata = {};
        if (role !== undefined && role !== previousRole) metadata.roleChanged = role;
        if (active !== undefined) metadata.active = user.active;
        if (assignedHospitalId && /^[A-Za-z0-9_.:-]{1,160}$/.test(assignedHospitalId)) metadata.hospitalId = assignedHospitalId;
        if (assignedCentreId && /^[A-Za-z0-9_.:-]{1,160}$/.test(assignedCentreId)) metadata.centreId = assignedCentreId;
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "USER_UPDATED", entityId: String(user._id),
          metadata, ip: req.ip, session
        });
        return { user };
      });
      if (result.error) return res.status(result.error.status).json({ success: false, message: result.error.message, errorCode: result.error.errorCode });
      const user = result.user;

      const safeUser = user.toObject();

      delete safeUser.passwordHash;
      delete safeUser.activeSessionId;
      delete safeUser.scopeRegistryVersion;

      res.json({
        success: true,
        message: "User updated successfully",
        data: safeUser
      });

    } catch (error) {
      console.error(error);

      if (error?.code === "HOSPITAL_SCOPE_LOCK_UNAVAILABLE") {
        return res.status(503).json({ success: false, message: "Hospital scope assignment is temporarily unavailable", errorCode: "HOSPITAL_SCOPE_LOCK_UNAVAILABLE" });
      }

      res.status(500).json({
        success: false,
        message: "Failed to update user",
        errorCode: "USER_UPDATE_ERROR"
      });
    }
  }
);


// =====================================================
// CHANGE PASSWORD
// Super Admin only
// =====================================================

router.put(
  "/:id/password",
  requireAuth,
  allowRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({
          success: false,
          message: "Password is required",
          errorCode: "PASSWORD_REQUIRED"
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const updated = await withTransaction(async session => {
        const user = await User.findById(req.params.id).session(session);
        if (!user) return false;
        user.passwordHash = passwordHash;
        user.activeSessionId = null;
        user.sessionVersion = (user.sessionVersion || 1) + 1;
        await user.save({ session });
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "USER_PASSWORD_CHANGED", entityId: String(user._id), ip: req.ip, session
        });
        return true;
      });

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "User not found",
          errorCode: "USER_NOT_FOUND"
        });
      }

      res.json({
        success: true,
        message: "Password changed successfully"
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to change password",
        errorCode: "PASSWORD_CHANGE_ERROR"
      });
    }
  }
);


// =====================================================
// FORCE LOGOUT
// Super Admin only
// =====================================================

router.post(
  "/:id/force-logout",
  requireAuth,
  allowRoles("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const updated = await withTransaction(async session => {
        const user = await User.findById(req.params.id).session(session);
        if (!user) return false;
        user.activeSessionId = null;
        user.sessionVersion = (user.sessionVersion || 1) + 1;
        await user.save({ session });
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "USER_FORCE_LOGOUT", entityId: String(user._id), ip: req.ip, session
        });
        return true;
      });

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "User not found",
          errorCode: "USER_NOT_FOUND"
        });
      }

      res.json({
        success: true,
        message: "User session invalidated successfully"
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to force logout",
        errorCode: "FORCE_LOGOUT_ERROR"
      });
    }
  }
);


module.exports = router;

const router = require("../http/router").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { publicErrorMessage } = require("../services/errorResponseService");
const { withTransaction } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");
const { requireAuth } = require("../middleware/auth");

const MAX_FAILED_LOGINS = 3;
const LOCK_MINUTES = 15;
const lockedMessage = until => `This account is locked after ${MAX_FAILED_LOGINS} wrong passwords. Try again after ${until.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST, or ask a Super Admin to unlock it.`;

router.post("/logout", requireAuth, async (req, res) => {
  try {
    const loggedOut = await withTransaction(async session => {
      const result = await User.updateOne({
        _id: req.user.id,
        active: true,
        activeSessionId: { $in: [req.user.sessionId, null] },
        sessionVersion: req.user.sessionVersion
      }, {
        $unset: { activeSessionId: 1 },
        $inc: { sessionVersion: 1 }
      }, { session });

      if (result.modifiedCount !== 1) return false;
      await recordOperationalEvent({
        actorId: String(req.user.id), role: req.user.role, event: "LOGOUT_SUCCESS",
        entityId: String(req.user.id), ip: req.ip, session
      });
      return true;
    });

    return res.json({ success: true, message: "Signed out successfully", data: { loggedOut } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: publicErrorMessage(error, "Logout failed"), errorCode: "LOGOUT_ERROR" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const user = await User.findOne({
      username,
      active: true
    });

    // A locked account is refused before the password is checked.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({ success: false, message: lockedMessage(user.lockedUntil), errorCode: "ACCOUNT_LOCKED" });
    }

    // Invalid login audit
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      await AuditLog.create({
        userId: user ? String(user._id) : "",
        role: user ? user.role : "",
        action: "LOGIN_FAILED",
        entity: "AUTH",
        ...(user ? { entityId: String(user._id) } : {}),
        summary: "Invalid login attempt",
        ip: req.ip
      });

      if (user) {
        // Count the failure atomically; the third one in a row locks the account.
        const counted = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLoginAttempts: 1 } }, { new: true }).lean();
        if (counted.failedLoginAttempts >= MAX_FAILED_LOGINS) {
          const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
          await User.updateOne({ _id: user._id }, { $set: { lockedUntil, failedLoginAttempts: 0 } });
          await AuditLog.create({ userId: String(user._id), role: user.role, action: "ACCOUNT_LOCKED", entity: "AUTH", entityId: String(user._id), summary: "Account locked after failed logins", ip: req.ip });
          return res.status(423).json({ success: false, message: lockedMessage(lockedUntil), errorCode: "ACCOUNT_LOCKED" });
        }
        const left = MAX_FAILED_LOGINS - counted.failedLoginAttempts;
        return res.status(401).json({
          success: false,
          message: `Invalid credentials. ${left} attempt${left === 1 ? "" : "s"} left before this account is locked for ${LOCK_MINUTES} minutes.`,
          errorCode: "INVALID_LOGIN"
        });
      }

      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
        errorCode: "INVALID_LOGIN"
      });
    }

    const sessionId = crypto.randomUUID();
    const confirmedReplacement = req.body?.confirmReplaceSession === true;
    const loginAt = new Date();
    const login = await withTransaction(async session => {
      const current = await User.findOne({ _id: user._id, active: true, passwordHash: user.passwordHash }).session(session);
      if (!current) return { inactive: true };
      const hasActiveHospitalSession = current.role === "HOSPITAL_USER" && current.activeSessionId && current.activeSessionId !== sessionId;
      if (hasActiveHospitalSession && !confirmedReplacement) {
        await recordOperationalEvent({ actorId: String(current._id), role: current.role, event: "LOGIN_BLOCKED_ACTIVE_SESSION", entityId: String(current._id), ip: req.ip, session });
        return { blocked: true };
      }
      if (typeof current.sessionVersion !== "number" || current.sessionVersion < 1) current.sessionVersion = 1;
      current.activeSessionId = sessionId;
      current.lastLoginAt = loginAt;
      current.failedLoginAttempts = 0;
      current.lockedUntil = undefined;
      await current.save({ session });
      if (hasActiveHospitalSession) {
        await recordOperationalEvent({ actorId: String(current._id), role: current.role, event: "SESSION_REPLACED", entityId: String(current._id), ip: req.ip, session });
      }
      await recordOperationalEvent({ actorId: String(current._id), role: current.role, event: "LOGIN_SUCCESS", entityId: String(current._id), ip: req.ip, session });
      return { user: current };
    });

    if (login.inactive) return res.status(401).json({ success: false, message: "Invalid credentials", errorCode: "INVALID_LOGIN" });
    if (login.blocked) return res.status(409).json({ success: false, message: "Account already has an active session. Confirm to continue on this device.", errorCode: "ACTIVE_SESSION" });
    const authenticatedUser = login.user;

    const token = jwt.sign(
      {
        id: authenticatedUser._id,
        username: authenticatedUser.username,
        role: authenticatedUser.role,
        hospitalId: authenticatedUser.hospitalId,
        centreId: authenticatedUser.centreId,
        chainId: authenticatedUser.chainId,
        sessionId,
        sessionVersion: authenticatedUser.sessionVersion
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "8h"
      }
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          username: authenticatedUser.username,
          name: authenticatedUser.name,
          role: authenticatedUser.role,
          hospitalId: authenticatedUser.hospitalId,
          centreId: authenticatedUser.centreId,
          chainId: authenticatedUser.chainId
        }
      }
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      message: publicErrorMessage(e, "Login failed"),
      errorCode: "LOGIN_ERROR"
    });
  }
});

module.exports = router;

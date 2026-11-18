const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");

const Order = require("../models/Order");
const Vial = require("../models/Vial");
const Donor = require("../models/Donor");
const User = require("../models/User");
const crypto = require("crypto");
const { withTransaction, RouteError, sendRouteError } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");
const { minimizeHospitalVial, minimizeHospitalOrder, minimizeCeoOrder } = require("../services/hospitalDataPrivacy");
const { getLinkedHospitalScopes, withLinkedHospitalScope } = require("../services/linkedHospitalScopeService");

// GET ORDERS
router.get(
  "/",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER",
    "CHAIN_CEO"
  ),
  async (req, res) => {
    try {
      const filter = {};
      if (req.user.role === "HOSPITAL_USER") {
        if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
        filter.hospitalId = req.user.hospitalId;
        filter.centreId = req.user.centreId;
      } else if (req.user.role === "CHAIN_CEO") {
        Object.assign(filter, withLinkedHospitalScope({}, await getLinkedHospitalScopes(req.user.id)));
      }
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
      const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
      const [orders, grouped] = await Promise.all([
        Order.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
        Order.aggregate([
          { $match: filter },
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ])
      ]);
      const byStatus = grouped.map(item => ({ status: item._id, count: item.count }));
      const total = byStatus.reduce((sum, item) => sum + item.count, 0);

      res.json({
        success: true,
        data: req.user.role === "HOSPITAL_USER" ? orders.map(minimizeHospitalOrder) : req.user.role === "CHAIN_CEO" ? orders.map(minimizeCeoOrder) : orders,
        summary: { total, byStatus },
        pagination: { skip, limit, total, hasMore: skip + orders.length < total },
        message: "Orders fetched successfully"
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch orders",
        errorCode: "ORDERS_FETCH_ERROR"
      });
    }
  }
);

// Create a hospital request or an ART Bank initiated shipment order.
router.post(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"),
  async (req, res) => {
    try {
      const { hospitalId, centreId, items, purpose, donorId } = req.body;

      if (!hospitalId || !centreId || !items || !items.length) {
        return res.status(400).json({
          success: false,
          message: "hospitalId, centreId and items are required",
          errorCode: "INVALID_ORDER"
        });
      }

      if (req.user.role === "HOSPITAL_USER") {
        if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
        if (hospitalId !== req.user.hospitalId || centreId !== req.user.centreId) {
          return res.status(403).json({ success: false, message: "You can only request stock for your own hospital and centre", errorCode: "HOSPITAL_SCOPE_DENIED" });
        }
      } else {
        const target = await User.exists({ role: "HOSPITAL_USER", active: true, hospitalId, centreId });
        if (!target) return res.status(400).json({ success: false, message: "Choose an active hospital and centre", errorCode: "INVALID_HOSPITAL_SCOPE" });
      }
      if (!Array.isArray(items) || items.some(item => !item || !item.bloodGroup || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1)) {
        return res.status(400).json({ success: false, message: "Each requested stock item needs a blood group and positive whole-number quantity", errorCode: "INVALID_ORDER_ITEMS" });
      }
      if (req.user.role === "HOSPITAL_USER" && donorId) {
        return res.status(403).json({ success: false, message: "Hospital users cannot select ART Bank donors for stock requests", errorCode: "DONOR_SELECTION_DENIED" });
      }
      if (donorId) {
        const donor = await Donor.findOne({ donorId, status: { $ne: "Inactive" } }).select("donorId").lean();
        if (!donor) return res.status(400).json({ success: false, message: "Select an active donor", errorCode: "INVALID_STOCK_DONOR" });
        const now = new Date();
        for (const item of items) {
          const count = await Vial.countDocuments({
            donorId, status: "AVAILABLE_AT_ART_BANK", quarantineEnd: { $lte: now },
            bloodGroup: String(item.bloodGroup).trim().toUpperCase()
          });
          if (count < Number(item.quantity)) {
            return res.status(400).json({ success: false, message: "The selected donor does not have enough released vials for this request", errorCode: "INSUFFICIENT_DONOR_STOCK" });
          }
        }
      }

      const orderId = `ORD-${crypto.randomUUID()}`;
      const order = await withTransaction(async session => {
        const [created] = await Order.create([{
          orderId,
          hospitalId,
          centreId,
          donorId: donorId || undefined,
          requestedBy: req.user.username,
          items: items.map(item => ({
            ...item,
            bloodGroup: String(item.bloodGroup).trim().toUpperCase(),
            quantity: Number(item.quantity)
          })),
          purpose: purpose || "",
          status: "PENDING"
        }], { session });
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: req.user.role === "HOSPITAL_USER" ? "ORDER_CREATED" : "BANK_DISPATCH_ORDER_CREATED", entityId: orderId,
          metadata: { status: "PENDING", count: items.length, hospitalId, centreId }, ip: req.ip, session
        });
        return created;
      });

      res.status(201).json({
        success: true,
        message: "Order created successfully",
        data: order
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to create order",
        errorCode: "ORDER_CREATE_ERROR"
      });
    }
  }
);

// DISPATCH ORDER - ART BANK
router.post(
  "/:orderId/dispatch",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF"
  ),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { vialIds, courierDetails } = req.body;
      const dispatchAt = new Date();

      const { order, vials } = await withTransaction(async session => {
        const currentOrder = await Order.findOne({ orderId }).session(session);
        if (!currentOrder) throw new RouteError(404, "Order not found", "ORDER_NOT_FOUND");
        if (currentOrder.status !== "PENDING") throw new RouteError(400, "Order cannot be dispatched in current status", "INVALID_ORDER_STATUS");
        if (!Array.isArray(vialIds) || !vialIds.length) throw new RouteError(400, "At least one vialId is required", "VIALS_REQUIRED");

        const currentVials = await Vial.find({ vialId: { $in: vialIds } }).session(session);
        if (currentVials.length !== vialIds.length) throw new RouteError(404, "One or more vials not found", "VIAL_NOT_FOUND");
        if (currentOrder.donorId && currentVials.some(vial => vial.donorId !== currentOrder.donorId)) {
          throw new RouteError(400, "Selected vials must belong to the donor chosen for this shipment", "ORDER_DONOR_MISMATCH");
        }

        const normalizeBloodGroup = value => String(value || "").trim().toUpperCase();
        const requestedCounts = new Map();
        for (const item of currentOrder.items || []) {
          const group = normalizeBloodGroup(item.bloodGroup);
          requestedCounts.set(group, (requestedCounts.get(group) || 0) + Number(item.quantity));
        }
        const selectedCounts = new Map();
        for (const vial of currentVials) {
          const group = normalizeBloodGroup(vial.bloodGroup);
          selectedCounts.set(group, (selectedCounts.get(group) || 0) + 1);
        }
        if (requestedCounts.size !== selectedCounts.size || [...requestedCounts].some(([group, quantity]) => selectedCounts.get(group) !== quantity)) {
          throw new RouteError(400, "Selected vials must match the order quantities by blood group", "ORDER_QUANTITY_MISMATCH");
        }

        const unavailable = currentVials.filter(vial => vial.status !== "AVAILABLE_AT_ART_BANK" || !vial.quarantineEnd || vial.quarantineEnd > dispatchAt);
        if (unavailable.length) throw new RouteError(400, "One or more vials are not available", "VIAL_NOT_AVAILABLE", { vialIds: unavailable.map(vial => vial.vialId) });

        for (const vial of currentVials) {
          const claimed = await Vial.updateOne(
            { _id: vial._id, status: "AVAILABLE_AT_ART_BANK", quarantineEnd: { $lte: dispatchAt } },
            {
              $set: { status: "DISPATCHED", currentLocation: currentOrder.hospitalId, hospitalId: currentOrder.hospitalId, centreId: currentOrder.centreId },
              $push: { statusHistory: { status: "DISPATCHED", at: dispatchAt, hospitalId: currentOrder.hospitalId, centreId: currentOrder.centreId, orderId: currentOrder.orderId, dispatchedBy: req.user.username } }
            },
            { session }
          );
          if (claimed.matchedCount !== 1) throw new RouteError(400, "One or more vials are not available", "VIAL_NOT_AVAILABLE", { vialIds: [vial.vialId] });
        }

        const updatedOrder = await Order.findOneAndUpdate(
          { _id: currentOrder._id, status: "PENDING" },
          { $set: { status: "DISPATCHED", dispatchedBy: req.user.username, vialIds, courierDetails: courierDetails || null, dispatchedAt: dispatchAt } },
          { new: true, session }
        );
        if (!updatedOrder) throw new RouteError(400, "Order cannot be dispatched in current status", "INVALID_ORDER_STATUS");

        const updatedVials = await Vial.find({ vialId: { $in: vialIds } }).session(session);
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "ORDER_DISPATCHED", entityId: currentOrder.orderId,
          metadata: { previousStatus: "PENDING", status: "DISPATCHED", count: updatedVials.length, hospitalId: currentOrder.hospitalId, centreId: currentOrder.centreId }, ip: req.ip, session
        });
        return { order: updatedOrder, vials: updatedVials };
      });

      res.json({
        success: true,
        message: "Order dispatched successfully",
        data: {
          order,
          vials
        }
      });

    } catch (error) {
      sendRouteError(res, error, { message: "Failed to dispatch order", errorCode: "ORDER_DISPATCH_ERROR" });
    }
  }
);

// RECEIVE / ISOLATE VIALS - HOSPITAL
router.post(
  "/:orderId/receive",
  requireAuth,
  allowRoles("HOSPITAL_USER"),
  async (req, res) => {
    try {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      const { orderId } = req.params;
      const { vialIds } = req.body;
      const receivedAt = new Date();

      const { order, vials } = await withTransaction(async session => {
        const currentOrder = await Order.findOne({ orderId, hospitalId: req.user.hospitalId, centreId: req.user.centreId }).session(session);
        if (!currentOrder) throw new RouteError(404, "Order not found", "ORDER_NOT_FOUND");
        if (currentOrder.status !== "DISPATCHED") throw new RouteError(400, "Order is not in dispatched status", "INVALID_ORDER_STATUS");
        if (!Array.isArray(vialIds) || !vialIds.length) throw new RouteError(400, "At least one vialId is required", "VIALS_REQUIRED");
        if (vialIds.length !== (currentOrder.vialIds || []).length || vialIds.some(id => !currentOrder.vialIds.includes(id))) {
          throw new RouteError(400, "Receipt must account for every vial in the dispatch", "INCOMPLETE_RECEIPT");
        }

        // Keep the receipt lookup itself within the authenticated hospital/centre
        // boundary. The order is already scope-checked above; mirror that scope
        // on the related vial query before loading vial records.
        const currentVials = await Vial.find({
          vialId: { $in: vialIds },
          hospitalId: currentOrder.hospitalId,
          centreId: currentOrder.centreId
        }).session(session);
        if (currentVials.length !== vialIds.length) throw new RouteError(404, "One or more vials not found", "VIAL_NOT_FOUND");
        const invalidVials = currentVials.filter(vial => vial.status !== "DISPATCHED" || vial.hospitalId !== currentOrder.hospitalId || vial.centreId !== currentOrder.centreId);
        if (invalidVials.length) throw new RouteError(400, "One or more vials are not valid for this hospital receipt", "INVALID_VIAL_RECEIPT", { vialIds: invalidVials.map(vial => vial.vialId) });

        for (const vial of currentVials) {
          const claimed = await Vial.updateOne(
            { _id: vial._id, status: "DISPATCHED", hospitalId: currentOrder.hospitalId, centreId: currentOrder.centreId },
            {
              $set: { status: "UNUSED_AT_HOSPITAL", currentLocation: currentOrder.hospitalId },
              $push: { statusHistory: { status: "UNUSED_AT_HOSPITAL", at: receivedAt, hospitalId: currentOrder.hospitalId, centreId: currentOrder.centreId, orderId: currentOrder.orderId, receivedBy: req.user.username } }
            },
            { session }
          );
          if (claimed.matchedCount !== 1) throw new RouteError(400, "One or more vials are not valid for this hospital receipt", "INVALID_VIAL_RECEIPT", { vialIds: [vial.vialId] });
        }

        const updatedOrder = await Order.findOneAndUpdate(
          { _id: currentOrder._id, status: "DISPATCHED", hospitalId: req.user.hospitalId, centreId: req.user.centreId },
          { $set: { status: "RECEIVED", receivedBy: req.user.username, receivedVialIds: vialIds, receivedAt } },
          { new: true, session }
        );
        if (!updatedOrder) throw new RouteError(400, "Order is not in dispatched status", "INVALID_ORDER_STATUS");
        const updatedVials = await Vial.find({ vialId: { $in: vialIds } }).session(session);
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "ORDER_RECEIVED", entityId: currentOrder.orderId,
          metadata: { previousStatus: "DISPATCHED", status: "RECEIVED", count: updatedVials.length, hospitalId: currentOrder.hospitalId, centreId: currentOrder.centreId }, ip: req.ip, session
        });
        return { order: updatedOrder, vials: updatedVials };
      });

      res.json({
        success: true,
        message: "Vials received and isolated successfully",
        data: {
          order: minimizeHospitalOrder(order),
          vials: vials.map(minimizeHospitalVial)
        }
      });

    } catch (error) {
      sendRouteError(res, error, { message: "Failed to receive vials", errorCode: "VIAL_RECEIVE_ERROR" });
    }
  }
);

module.exports = router;

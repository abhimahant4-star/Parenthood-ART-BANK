const jwt = require("jsonwebtoken");
const User = require("../models/User");

function sessionVersionMatches(tokenVersion, storedVersion) {
  const currentVersion = Number.isInteger(storedVersion) && storedVersion >= 1 ? storedVersion : 1;
  return Number.isInteger(tokenVersion) && tokenVersion >= 1 && tokenVersion === currentVersion;
}

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
      errorCode: "AUTH_REQUIRED"
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);

    if (!user || !user.active) {
      return res.status(401).json({
        success: false,
        message: "Account inactive or not found",
        errorCode: "ACCOUNT_INACTIVE"
      });
    }

    if (decoded.role !== user.role || decoded.hospitalId !== user.hospitalId || decoded.centreId !== user.centreId || decoded.chainId !== user.chainId) {
      return res.status(401).json({ success: false, message: "Account access scope changed; sign in again", errorCode: "AUTH_SCOPE_CHANGED" });
    }

    // Check current active browser session
    if (
      user.activeSessionId &&
      decoded.sessionId !== user.activeSessionId
    ) {
      return res.status(401).json({
        success: false,
        message: "This session has been replaced by another login",
        errorCode: "SESSION_REPLACED"
      });
    }

    // Check session version
    if (!sessionVersionMatches(decoded.sessionVersion, user.sessionVersion)) {
      return res.status(401).json({
        success: false,
        message: "This session has been revoked",
        errorCode: "SESSION_REVOKED"
      });
    }

    req.user = decoded;

    next();

  } catch (e) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session",
      errorCode: "AUTH_INVALID"
    });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (
      !req.user ||
      !roles.includes(req.user.role)
    ) {
      return res.status(403).json({
        success: false,
        message: "Permission denied",
        errorCode: "FORBIDDEN"
      });
    }

    next();
  };
}

module.exports = {
  requireAuth,
  allowRoles,
  sessionVersionMatches
};

const router=require("../http/router").Router();
const {requireAuth,allowRoles}=require("../middleware/auth");
const Vial=require("../models/Vial");
const Donor=require("../models/Donor");
const asyncHandler=require("../middleware/asyncHandler");
const {withTransaction,RouteError,sendRouteError}=require("../services/transactionService");
const {recordOperationalEvent}=require("../services/operationalAuditService");
const {minimizeHospitalVial}=require("../services/hospitalDataPrivacy");
const {getLinkedHospitalScopes,withLinkedHospitalScope}=require("../services/linkedHospitalScopeService");
const escapeRegex=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

router.get("/",requireAuth,allowRoles("SUPER_ADMIN","ART_BANK_ADMIN","ART_BANK_STAFF","HOSPITAL_USER","CHAIN_CEO"),asyncHandler(async(req,res)=>{
  let filter={};
  let ceoScopes;
  if(req.user.role==="HOSPITAL_USER") {
    if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({success:false,message:"Hospital account has no assigned hospital/centre",errorCode:"HOSPITAL_SCOPE_MISSING"});
    filter.hospitalId=req.user.hospitalId;
    filter.centreId=req.user.centreId;
  } else if(req.user.role==="CHAIN_CEO") {
    ceoScopes=await getLinkedHospitalScopes(req.user.id);
  }
  if(req.query.status) filter.status=req.query.status;
  const bloodGroup=String(req.query.bloodGroup||"").trim().slice(0,32);
  if(bloodGroup) filter.bloodGroup=new RegExp(`^${escapeRegex(bloodGroup)}$`,"i");
  if(["SUPER_ADMIN","ART_BANK_ADMIN","ART_BANK_STAFF"].includes(req.user.role) && req.query.donorId) filter.donorId=req.query.donorId;
  if(req.query.stockClassification==="__UNSPECIFIED__") filter.stockClassification={$in:[null,""]};
  else if(req.query.stockClassification) filter.stockClassification=req.query.stockClassification;
  if(req.query.location) filter.currentLocation=String(req.query.location).slice(0,160);
  const search=String(req.query.q||"").trim().slice(0,100);
  if(search) {
    const pattern=new RegExp(escapeRegex(search),"i");
    const or=["HOSPITAL_USER","CHAIN_CEO"].includes(req.user.role)
      ? [{vialId:pattern},{currentLocation:pattern}]
      : [{vialId:pattern},{batchId:pattern},{donorId:pattern},{currentLocation:pattern}];
    if(["SUPER_ADMIN","ART_BANK_ADMIN","ART_BANK_STAFF"].includes(req.user.role)) {
      const matchingDonors=await Donor.find({uhid:pattern}).select("donorId").lean();
      if(matchingDonors.length) or.push({donorId:{$in:matchingDonors.map(donor=>donor.donorId)}});
    }
    filter.$or=or;
  }
  if(req.user.role==="CHAIN_CEO") filter=withLinkedHospitalScope(filter,ceoScopes);
  const parsedLimit = req.query.limit === undefined ? 500 : Number.parseInt(req.query.limit, 10);
  const parsedSkip = req.query.skip === undefined ? 0 : Number.parseInt(req.query.skip, 10);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500 || !Number.isInteger(parsedSkip) || parsedSkip < 0 || parsedSkip > 100000) {
    return res.status(400).json({ success: false, message: "Vial pagination values are invalid", errorCode: "INVALID_PAGINATION" });
  }
  const [vials, total] = await Promise.all([
    Vial.find(filter).sort({createdAt:-1, _id:-1}).skip(parsedSkip).limit(parsedLimit).lean(),
    Vial.countDocuments(filter)
  ]);
  const donors=["HOSPITAL_USER","CHAIN_CEO"].includes(req.user.role) ? [] : await Donor.find({donorId:{$in:[...new Set(vials.map(vial=>vial.donorId))]}}).select("donorId uhid").lean();
  const uhidByDonorId=new Map(donors.map(donor=>[donor.donorId,donor.uhid]));
  const data=vials.map(vial=>{
    const record={...vial,donorUhid:uhidByDonorId.get(vial.donorId)||vial.donorId};
    return ["HOSPITAL_USER","CHAIN_CEO"].includes(req.user.role) ? minimizeHospitalVial(record) : record;
  });
  res.json({success:true,data,pagination:{skip:parsedSkip,limit:parsedLimit,total,hasMore:parsedSkip+vials.length<total}});
}));

router.get("/:vialId",requireAuth,allowRoles("SUPER_ADMIN","ART_BANK_ADMIN","ART_BANK_STAFF","HOSPITAL_USER"),asyncHandler(async(req,res)=>{
  const filter={vialId:req.params.vialId};
  if(req.user.role==="HOSPITAL_USER") {
    if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({success:false,message:"Hospital account has no assigned hospital/centre",errorCode:"HOSPITAL_SCOPE_MISSING"});
    filter.hospitalId=req.user.hospitalId;
    filter.centreId=req.user.centreId;
  }
  const vial=await Vial.findOne(filter).lean();
  if(!vial)return res.status(404).json({success:false,message:"Vial not found",errorCode:"VIAL_NOT_FOUND"});
  if(req.user.role==="HOSPITAL_USER") {
    return res.json({success:true,data:minimizeHospitalVial(vial)});
  }
  const donor=await Donor.findOne({donorId:vial.donorId}).select("uhid").lean();
  res.json({success:true,data:{...vial,donorUhid:donor?.uhid||vial.donorId}});
}));

router.patch("/:vialId/status",requireAuth,allowRoles("SUPER_ADMIN","ART_BANK_ADMIN"),asyncHandler(async(req,res)=>{
  const {status}=req.body;
  const allowed=["CREATED","QUARANTINED","RELEASED","AVAILABLE_AT_ART_BANK","DISPATCHED","UNUSED_AT_HOSPITAL","RETURNED_BEFORE_MAPPING","MAPPED_USED","BLOCKED","RECALLED","DISCARDED","EXPIRED"];
  if(!allowed.includes(status))return res.status(400).json({success:false,message:"Invalid vial status"});
  const transitions={
    QUARANTINED:["BLOCKED","RECALLED"],
    RELEASED:["BLOCKED","RECALLED"],
    AVAILABLE_AT_ART_BANK:["BLOCKED","RECALLED"],
    DISPATCHED:["BLOCKED","RECALLED"],
    UNUSED_AT_HOSPITAL:["BLOCKED","RECALLED"],
    BLOCKED:["RECALLED"],
    RECALLED:[]
  };
  const changedAt=new Date();
  let updated;
  try {
    updated=await withTransaction(async session=>{
      const vial=await Vial.findOne({vialId:req.params.vialId}).session(session);
      if(!vial)throw new RouteError(404,"Vial not found","VIAL_NOT_FOUND");
      if(!(transitions[vial.status]||[]).includes(status))throw new RouteError(409,`Invalid vial transition: ${vial.status} to ${status}`,"INVALID_VIAL_TRANSITION");
      const previousStatus=vial.status;
      const changed=await Vial.findOneAndUpdate(
        {vialId:req.params.vialId,status:previousStatus},
        {$set:{status},$push:{statusHistory:{status,at:changedAt,user:req.user.username}}},
        {new:true,runValidators:true,session}
      );
      if(!changed)throw new RouteError(409,`Invalid vial transition: ${previousStatus} to ${status}`,"INVALID_VIAL_TRANSITION");
      await recordOperationalEvent({actorId:String(req.user.id),role:req.user.role,event:"VIAL_STATUS_CHANGED",entityId:changed.vialId,metadata:{previousStatus,status},ip:req.ip,session});
      return changed;
    });
  } catch(error) {
    return sendRouteError(res,error,{message:"Failed to update vial status",errorCode:"VIAL_STATUS_UPDATE_ERROR"});
  }
  res.json({success:true,message:"Vial status updated",data:updated});
}));
module.exports=router;

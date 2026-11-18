const mongoose=require("mongoose");
const schema=new mongoose.Schema({
  vialId:{type:String,unique:true,index:true,required:true},
  donorId:{type:String,index:true,required:true},
  batchId:{type:String,index:true,required:true},
  bloodGroup:String,
  stockClassification:{type:String,enum:["KARYOTYPE_TESTED","NORMAL_STOCK"]},
  barcode:String,
  quarantineEnd:Date,
  currentLocation:String,
  hospitalId:String,
  centreId:String,
  status:{type:String,enum:["CREATED","QUARANTINED","RELEASED","AVAILABLE_AT_ART_BANK","DISPATCHED","UNUSED_AT_HOSPITAL","RETURNED_BEFORE_MAPPING","MAPPED_USED","BLOCKED","RECALLED","DISCARDED","EXPIRED"],index:true},
  statusHistory:[mongoose.Schema.Types.Mixed]
},{timestamps:true});
module.exports=mongoose.models.Vial || mongoose.model("Vial", schema);

const mongoose=require("mongoose");
const schema=new mongoose.Schema({
  donorId:{type:String,unique:true,index:true,required:true},
  uhid:{type:String,unique:true,sparse:true,index:true},
  manualDonorId:{type:String,unique:true,sparse:true,index:true,maxlength:50},
  unitNumber:{type:String,unique:true,sparse:true,index:true,maxlength:30},
  lastCollectionAt:Date,
  name:{type:String,required:true},
  aadhaarHash:String,
  aadhaarMasked:String,
  dob:Date,
  maritalStatus:{type:String,enum:["MARRIED","UNMARRIED"]},
  bloodGroup:String,
  height:String,
  weight:String,
  complexion:String,
  eyeColour:String,
  hairColour:String,
  build:String,
  status:{type:String,default:"Active"},
  consent:mongoose.Schema.Types.Mixed,
  operationalInfo:mongoose.Schema.Types.Mixed
},{timestamps:true});
module.exports=mongoose.models.Donor || mongoose.model("Donor", schema);

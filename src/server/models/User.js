const mongoose=require("mongoose");

const schema=new mongoose.Schema({

  username:{type:String,unique:true,index:true,required:true},

  passwordHash:{type:String,required:true},

  name:String,

  role:{
    type:String,
    enum:[
      "SUPER_ADMIN",
      "ART_BANK_ADMIN",
      "ART_BANK_STAFF",
      "HOSPITAL_USER",
      "CHAIN_CEO"
    ],
    required:true
  },

  hospitalId:String,

  hospitalName:String,

  centreId:String,

  centreName:String,

  chainId:String,

  linkedCeoId:String,

  active:{
    type:Boolean,
    default:true
  },

  activeSessionId:String,

  sessionVersion:{
    type:Number,
    default:1
  },

  // Transactional serialization key for named hospital/centre scope assignment.
  scopeRegistryVersion:{type:Number,default:0,select:false},

  lastLoginAt:Date,

  // Login lockout: 3 wrong passwords in a row lock the account for a while.
  failedLoginAttempts:{type:Number,default:0},
  lockedUntil:Date

},{timestamps:true});

module.exports=mongoose.models.User || mongoose.model("User", schema);

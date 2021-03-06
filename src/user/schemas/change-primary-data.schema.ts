import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";
import { UserDocument } from "./user.schema";

export type ChangePrimaryDataDocument = ChangePrimaryData & Document;

@Schema()
class ChangePrimaryData {
  @Prop({ required: true, index: false, ref: "User", type: Types.ObjectId })
  user: Types.ObjectId;

  @Prop({ required: true, index: true })
  verification: string;

  @Prop({ required: true, index: false })
  expires: number;

  @Prop({ required: true, index: false })
  ipOfRequest: string;

  @Prop({ required: true, index: false })
  browserOfRequest: string;

  @Prop({ required: true, index: false })
  fingerprintOfRequest: string;

  @Prop({ required: true, index: false })
  dataType: "email" | "password" | "username" | "phone";

  @Prop({ required: true, index: false })
  verified: boolean;
}

export const ChangePrimaryDataSchema = SchemaFactory.createForClass(ChangePrimaryData);

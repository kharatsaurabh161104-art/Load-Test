import mongoose, { Schema, Document } from "mongoose";

export interface IApiStat extends Document {
    route: string;
    hits: number;
}

const ApiStatSchema: Schema = new Schema({
    route: { type: String, required: true, unique: true },
    hits: { type: Number, default: 0 }
});

export const ApiStat = mongoose.model<IApiStat>("ApiStat", ApiStatSchema);

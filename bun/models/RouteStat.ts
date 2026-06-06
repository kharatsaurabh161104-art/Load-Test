import mongoose, { Schema, Document } from "mongoose";

export interface IRouteStat extends Document {
    route: string;
    hits: number;
}

const RouteStatSchema: Schema = new Schema({
    route: { type: String, required: true, unique: true },
    hits: { type: Number, default: 0 }
});

export const RouteStat = mongoose.model<IRouteStat>("RouteStat", RouteStatSchema);

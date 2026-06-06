import mongoose, { Schema, Document } from "mongoose";

export interface IBenchmarkHistory extends Document {
    id: number;
    tested_url: string;
    domain: string;
    connections: number;
    duration: number;
    timeout: number;
    avg_latency: number;
    max_latency: number;
    avg_req_per_sec: number;
    total_requests: number;
    success_requests: number;
    blocked_requests: number;
    failed_requests: number;
    throughput_mb: number;
    errors: number;
    timeouts: number;
    non2xx: number;
    status: string;
    stop_reason: string | null;
    created_at: Date;
}

const BenchmarkHistorySchema: Schema = new Schema({
    id: { type: Number, required: true, unique: true },
    tested_url: { type: String, required: true },
    domain: { type: String, required: true },
    connections: { type: Number, required: true },
    duration: { type: Number, required: true },
    timeout: { type: Number, required: true },
    avg_latency: { type: Number, default: 0 },
    max_latency: { type: Number, default: 0 },
    avg_req_per_sec: { type: Number, default: 0 },
    total_requests: { type: Number, default: 0 },
    success_requests: { type: Number, default: 0 },
    blocked_requests: { type: Number, default: 0 },
    failed_requests: { type: Number, default: 0 },
    throughput_mb: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
    timeouts: { type: Number, default: 0 },
    non2xx: { type: Number, default: 0 },
    status: { type: String, default: "completed" },
    stop_reason: { type: String, default: null },
    created_at: { type: Date, default: Date.now }
}, {
    suppressReservedKeysWarning: true
});

export const BenchmarkHistory = mongoose.model<IBenchmarkHistory>("BenchmarkHistory", BenchmarkHistorySchema);

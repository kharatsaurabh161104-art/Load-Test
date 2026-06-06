import dns from "dns";
import mongoose from "mongoose";

// Bypasses local DNS SRV resolution blockages
try {
    dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch (e) {
    console.warn("Could not set public DNS servers, relying on system defaults:", e);
}

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb+srv://rahul_123:rahul_123@cluster0.uqzrhnx.mongodb.net/Roomify-Database";

export const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Centralized MongoDB Connected successfully.");
    } catch (error) {
        console.error("Centralized MongoDB initial connection error:", error);
    }
};

mongoose.connection.on("error", err => {
    console.error("MongoDB connection error at runtime:", err);
});

mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected. Re-connecting automatically when requests are made...");
});

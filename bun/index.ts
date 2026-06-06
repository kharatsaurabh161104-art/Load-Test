import express from "express";
import autocannon from "autocannon";
import { connectDB } from "./db/db";
import { ApiStat } from "./models/ApiStat";
import { RouteStat } from "./models/RouteStat";
import { BenchmarkHistory } from "./models/BenchmarkHistory";
import Table from "cli-table3";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();

app.use(express.json());

// Unique instance identification (persistent on disk to recognize device restarts)
const hostname = os.hostname();
const pid = process.pid;
const instanceIdFile = path.join(__dirname, "instance-id.txt");
let instanceId = "";

try {
    if (fs.existsSync(instanceIdFile)) {
        instanceId = fs.readFileSync(instanceIdFile, "utf8").trim();
    }
} catch (e) {
    console.error("Failed to read persistent instance ID:", e);
}

if (!instanceId) {
    const port = process.env.PORT || "3000";
    const randomSuffix = Math.random().toString(36).substring(2, 5);
    instanceId = `node-${hostname}-${port}-${randomSuffix}`;
    try {
        fs.writeFileSync(instanceIdFile, instanceId, "utf8");
    } catch (e) {
        console.error("Failed to save persistent instance ID:", e);
    }
}

let requestCountSinceLastMetric = 0;
let bytesTransferredSinceLastMetric = 0;

const logFilePath = path.join(__dirname, "metrics.log");

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

// Start periodic heartbeat telemetry log loop
setInterval(() => {
    const usage = process.cpuUsage(lastCpuUsage);
    const timeElapsed = Date.now() - lastCpuTime;
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = Date.now();
    
    const totalCpuMs = (usage.user + usage.system) / 1000;
    const cpuPercent = Math.min(100, Math.max(0, (totalCpuMs / timeElapsed) * 100));

    const memoryUsedMb = process.memoryUsage().rss / 1024 / 1024;

    const intervalSec = 10;
    const reqPerSec = requestCountSinceLastMetric / intervalSec;
    const throughputKbps = (bytesTransferredSinceLastMetric / 1024) / intervalSec;

    // Reset counters
    requestCountSinceLastMetric = 0;
    bytesTransferredSinceLastMetric = 0;

    const logEntry = {
        instanceId,
        hostname,
        pid,
        timestamp: new Date().toISOString(),
        cpuPercent: parseFloat(cpuPercent.toFixed(2)),
        memoryUsedMb: parseFloat(memoryUsedMb.toFixed(2)),
        reqPerSec: parseFloat(reqPerSec.toFixed(2)),
        throughputKbps: parseFloat(throughputKbps.toFixed(2))
    };

    try {
        fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + "\n");

        if (fs.existsSync(logFilePath)) {
            const fileContent = fs.readFileSync(logFilePath, "utf8");
            const lines = fileContent.trim().split("\n");
            if (lines.length > 1000) {
                fs.writeFileSync(logFilePath, lines.slice(-1000).join("\n") + "\n");
            }
        }
    } catch (err) {
        console.error("Failed to write local telemetry metrics:", err);
    }
}, 10000);

// Track active tests in memory
interface ActiveTest {
    id: string;
    url: string;
    domain: string;
    connections: number;
    duration: number;
    timeout: number;
    startedAt: string;
    instance?: autocannon.Instance;
}

const activeTests = new Map<string, ActiveTest>();

// Helper to extract domain from URL
function extractDomain(urlStr: string): string {
    try {
        let cleanUrl = urlStr.trim();
        if (!/^https?:\/\//i.test(cleanUrl)) {
            cleanUrl = "http://" + cleanUrl;
        }
        const parsed = new URL(cleanUrl);
        return parsed.hostname;
    } catch (e) {
        return urlStr;
    }
}

// Helper to save benchmark results to DB
interface SaveBenchmarkParams {
    url: string;
    domain: string;
    connections: number;
    duration: number;
    timeout: number;
    avgLatency: number;
    maxLatency: number;
    avgReqPerSec: number;
    totalRequests: number;
    successRequests: number;
    blockedRequests: number;
    failedRequests: number;
    throughputMb: number;
    errors: number;
    timeouts: number;
    non2xx: number;
    status: string;
    stopReason: string | null;
}

async function saveBenchmarkResult(params: SaveBenchmarkParams) {
    try {
        // Compute max id to auto-increment
        const maxItem = await BenchmarkHistory.findOne().sort({ id: -1 });
        const nextId = maxItem && typeof maxItem.id === "number" ? maxItem.id + 1 : 1;

        const historyItem = new BenchmarkHistory({
            id: nextId,
            tested_url: params.url,
            domain: params.domain,
            connections: params.connections,
            duration: params.duration,
            timeout: params.timeout,
            avg_latency: params.avgLatency,
            max_latency: params.maxLatency,
            avg_req_per_sec: params.avgReqPerSec,
            total_requests: params.totalRequests,
            success_requests: params.successRequests,
            blocked_requests: params.blockedRequests,
            failed_requests: params.failedRequests,
            throughput_mb: params.throughputMb,
            errors: params.errors,
            timeouts: params.timeouts,
            non2xx: params.non2xx,
            status: params.status,
            stop_reason: params.stopReason
        });
        await historyItem.save();
    } catch (err) {
        console.error("Error saving benchmark result:", err);
    }
}

// Middleware to track incoming request rate and outgoing response bytes
app.use((req, res, next) => {
    requestCountSinceLastMetric++;
    
    let responseBytes = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;
    
    res.write = function (chunk: any, ...args: any[]) {
        if (chunk) {
            if (typeof chunk === "string") {
                responseBytes += Buffer.byteLength(chunk);
            } else {
                responseBytes += chunk.length || 0;
            }
        }
        return originalWrite.apply(this, [chunk, ...args]);
    };
    
    res.end = function (chunk: any, ...args: any[]) {
        if (chunk) {
            if (typeof chunk === "string") {
                responseBytes += Buffer.byteLength(chunk);
            } else {
                responseBytes += chunk.length || 0;
            }
        }
        bytesTransferredSinceLastMetric += responseBytes;
        return originalEnd.apply(this, [chunk, ...args]);
    };
    
    next();
});

// Middleware to log API calls
app.use(async (req, _, next) => {
    try {
        await ApiStat.findOneAndUpdate(
            { route: req.path },
            { $inc: { hits: 1 } },
            { upsert: true, returnDocument: "after" }
        );

        await RouteStat.findOneAndUpdate(
            { route: req.path },
            { $inc: { hits: 1 } },
            { upsert: true, returnDocument: "after" }
        );
    } catch (err) {
        console.error("Error logging API stats:", err);
    }
    next();
});

// Serve frontend views
app.get("/test-runner", (_, res) => {
    res.sendFile(path.join(__dirname, "views", "test-runner.html"));
});

app.get("/admin", (_, res) => {
    res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.get("/", (_, res) => {
    res.json({
        message: "Load Monitor Running",
        endpoints: {
            dashboard: "/dashboard",
            testRunner: "/test-runner",
            health: "/health"
        }
    });
});

app.get("/health", (_, res) => {
    res.json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date(),
        memory: process.memoryUsage()
    });
});

// Original /dashboard route with initial HTML templating fallback
app.get("/dashboard", async (_, res) => {
    try {
        const globalAvgLatencyResult = await BenchmarkHistory.aggregate([
            { $match: { status: "completed", avg_latency: { $gt: 0 } } },
            { $group: { _id: null, val: { $avg: "$avg_latency" } } }
        ]);

        const totalBandwidthResult = await BenchmarkHistory.aggregate([
            { $group: { _id: null, val: { $sum: { $multiply: ["$throughput_mb", "$duration"] } } } }
        ]);

        const blockRateResult = await BenchmarkHistory.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: "$total_requests" },
                    blocked: { $sum: "$blocked_requests" }
                }
            }
        ]);

        const totalBenchmarks = await BenchmarkHistory.countDocuments();
        
        const distinctDomains = await BenchmarkHistory.distinct("domain");

        const latest = await BenchmarkHistory.findOne().sort({ created_at: -1 });

        const routeStats = await RouteStat.find().sort({ hits: -1 });

        // Dynamic website stats from benchmark runs
        const websiteStats = await BenchmarkHistory.aggregate([
            {
                $group: {
                    _id: "$tested_url",
                    tested_url: { $first: "$tested_url" },
                    times_tested: { $sum: 1 },
                    total_requests: { $sum: "$total_requests" },
                    avg_req_per_sec: { $avg: "$avg_req_per_sec" },
                    avg_latency: { $avg: "$avg_latency" },
                    max_latency: { $max: "$max_latency" },
                    total_errors: { $sum: { $add: ["$errors", "$timeouts", "$non2xx"] } }
                }
            },
            { $sort: { total_requests: -1 } }
        ]);

        const history = await BenchmarkHistory.find().sort({ id: -1 }).limit(100);

        const topSites = await BenchmarkHistory.aggregate([
            {
                $group: {
                    _id: "$tested_url",
                    tested_url: { $first: "$tested_url" },
                    times_tested: { $sum: 1 },
                    total_requests: { $sum: "$total_requests" }
                }
            },
            { $sort: { total_requests: -1 } },
            { $limit: 10 }
        ]);

        const routeRows = routeStats
            .map(route => `
                <tr>
                    <td>${route.route}</td>
                    <td>${route.hits}</td>
                </tr>
            `)
            .join("");

        const websiteRows = websiteStats
            .map(site => `
                <tr>
                    <td class="url">${site.tested_url}</td>
                    <td>${site.times_tested}</td>
                    <td>${(site.total_requests || 0).toLocaleString()}</td>
                    <td>${(site.avg_req_per_sec || 0).toFixed(2)}</td>
                    <td>${(site.avg_latency || 0).toFixed(2)} ms</td>
                    <td>${(site.max_latency || 0).toFixed(2)} ms</td>
                    <td>${site.total_errors}</td>
                </tr>
            `)
            .join("");

        const historyRows = history
            .map(item => {
                const statusPill = item.status === 'completed' 
                    ? '<span class="pill success">Completed</span>' 
                    : `<span class="pill warning" title="${item.stop_reason || ''}">Rate Limit Stop</span>`;
                return `
                    <tr>
                        <td>${item.id}</td>
                        <td class="url">${item.tested_url}</td>
                        <td>${item.connections}</td>
                        <td>${item.duration}s</td>
                        <td>${(item.avg_req_per_sec || 0).toFixed(2)}</td>
                        <td>${(item.avg_latency || 0).toFixed(2)} ms</td>
                        <td>${(item.success_requests || 0).toLocaleString()}</td>
                        <td>${(item.blocked_requests || 0).toLocaleString()}</td>
                        <td>${statusPill}</td>
                        <td>${new Date(item.created_at).toLocaleString()}</td>
                    </tr>
                `;
            })
            .join("");

        const topSiteRows = topSites
            .map(site => `
                <tr>
                    <td class="url">${site.tested_url}</td>
                    <td>${site.times_tested}</td>
                    <td>${(site.total_requests || 0).toLocaleString()}</td>
                </tr>
            `)
            .join("");

        let html = fs.readFileSync(
            path.join(__dirname, "views", "dashboard.html"),
            "utf8"
        );

        const globalAvgLatency = globalAvgLatencyResult[0]?.val ?? 0;
        const bw = totalBandwidthResult[0]?.val ?? 0;
        const blockRate = (blockRateResult[0] && blockRateResult[0].total > 0)
            ? (blockRateResult[0].blocked * 100) / blockRateResult[0].total
            : 0;

        const latencyVal = globalAvgLatency ? `${globalAvgLatency.toFixed(2)} ms` : "0 ms";
        const bwVal = bw > 1024 ? `${(bw / 1024).toFixed(2)} GB` : `${bw.toFixed(2)} MB`;
        const blockVal = `${blockRate.toFixed(1)}%`;

        html = html
            .replaceAll("{{TOTAL_HITS}}", String(routeStats.reduce((sum, r) => sum + r.hits, 0)))
            .replaceAll("{{TOTAL_BENCHMARKS}}", String(totalBenchmarks))
            .replaceAll("{{TOTAL_SITES}}", String(distinctDomains.length))
            .replaceAll("{{GLOBAL_LATENCY}}", latencyVal)
            .replaceAll("{{TOTAL_BANDWIDTH}}", bwVal)
            .replaceAll("{{WAF_BLOCK_RATE}}", blockVal)
            .replaceAll("{{LATEST_URL}}", latest?.tested_url ?? "-")
            .replaceAll("{{LATEST_CONNECTIONS}}", String(latest?.connections ?? "-"))
            .replaceAll("{{LATEST_DURATION}}", String(latest?.duration ?? "-"))
            .replaceAll(
                "{{LATEST_REQ_SEC}}",
                latest ? latest.avg_req_per_sec.toFixed(2) : "-"
            )
            .replaceAll(
                "{{LATEST_LATENCY}}",
                latest ? latest.avg_latency.toFixed(2) : "-"
            )
            .replaceAll("{{ROUTE_ROWS}}", routeRows)
            .replaceAll("{{WEBSITE_ROWS}}", websiteRows)
            .replaceAll("{{HISTORY_ROWS}}", historyRows)
            .replaceAll("{{TOP_SITE_ROWS}}", topSiteRows);

        res.send(html);
    } catch (error) {
        console.error("Error rendering dashboard, loading fallback:", error);
        try {
            let html = fs.readFileSync(
                path.join(__dirname, "views", "dashboard.html"),
                "utf8"
            );
            
            const dbWarning = `
                <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem; color: #f87171; display: flex; align-items: center; justify-content: space-between;">
                    <span><strong>Database Offline:</strong> Connection to MongoDB failed. Showing offline fallback stats.</span>
                </div>
            `;
            html = html.replace('<div class="container">', '<div class="container">\n' + dbWarning);

            html = html
                .replaceAll("{{TOTAL_HITS}}", "0")
                .replaceAll("{{TOTAL_BENCHMARKS}}", "0")
                .replaceAll("{{TOTAL_SITES}}", "0")
                .replaceAll("{{GLOBAL_LATENCY}}", "0 ms")
                .replaceAll("{{TOTAL_BANDWIDTH}}", "0 MB")
                .replaceAll("{{WAF_BLOCK_RATE}}", "0.0%")
                .replaceAll("{{LATEST_URL}}", "-")
                .replaceAll("{{LATEST_CONNECTIONS}}", "-")
                .replaceAll("{{LATEST_DURATION}}", "-")
                .replaceAll("{{LATEST_REQ_SEC}}", "-")
                .replaceAll("{{LATEST_LATENCY}}", "-")
                .replaceAll("{{ROUTE_ROWS}}", '<tr><td colspan="2" class="empty-state">Database offline.</td></tr>')
                .replaceAll("{{WEBSITE_ROWS}}", '<tr><td colspan="7" class="empty-state">Database offline.</td></tr>')
                .replaceAll("{{HISTORY_ROWS}}", '<tr><td colspan="10" class="empty-state" style="color: #f87171;">Database connection offline. Historical data could not be retrieved.</td></tr>')
                .replaceAll("{{TOP_SITE_ROWS}}", '<tr><td colspan="3" class="empty-state">Database offline.</td></tr>');

            res.send(html);
        } catch (readErr) {
            res.status(500).send("Critical error loading dashboard fallback: " + (readErr as Error).message);
        }
    }
});

// Original /test route with upgrades to match the database and rate limit requirements
app.get("/test", async (req, res) => {
    try {
        const url = req.query.url as string;
        const connections = Number(req.query.connections ?? 10);
        const duration = Number(req.query.duration ?? 30);
        const timeout = Number(req.query.timeout ?? 5);
        const removeCache = req.query.removeCache === "true" || req.query.removeCache === true;

        if (!url) {
            return res.status(400).send("url query parameter required");
        }

        const domain = extractDomain(url);
        let successCount = 0;
        let blockedCount = 0;
        let otherErrorCount = 0;
        let stoppedEarly = false;
        let stopReason = "";
        let isStopped = false;

        let targetUrl = url;
        const headers: Record<string, string> = {};
        let requests: any[] | undefined = undefined;

        if (removeCache) {
            headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
            headers["Pragma"] = "no-cache";
            headers["Expires"] = "0";
            try {
                const parsed = new URL(url);
                const basePath = parsed.pathname + parsed.search;
                requests = [
                    {
                        method: "GET",
                        path: basePath,
                        setupRequest: (req: any) => {
                            const cbVal = Date.now().toString() + Math.random().toString(36).substring(2, 5);
                            const separator = req.path.includes("?") ? "&" : "?";
                            req.path = req.path + separator + "_cb=" + cbVal;
                            return req;
                        }
                    }
                ];
            } catch (e) {
                requests = [
                    {
                        method: "GET",
                        path: "/",
                        setupRequest: (req: any) => {
                            const cbVal = Date.now().toString() + Math.random().toString(36).substring(2, 5);
                            const separator = req.path.includes("?") ? "&" : "?";
                            req.path = req.path + separator + "_cb=" + cbVal;
                            return req;
                        }
                    }
                ];
            }
        }

        const testId = Date.now().toString() + Math.random().toString(36).substring(2, 5);

        const result = await new Promise<autocannon.Result>((resolve, reject) => {
            const autocannonOpts: autocannon.Options = {
                url: targetUrl,
                connections,
                duration,
                timeout,
                headers,
            };
            if (requests) {
                autocannonOpts.requests = requests;
            }
            const instance = autocannon(
                autocannonOpts,
                (err, resResult) => {
                    activeTests.delete(testId);
                    if (err) reject(err);
                    else resolve(resResult);
                }
            );

            activeTests.set(testId, {
                id: testId,
                url,
                domain,
                connections,
                duration,
                timeout,
                startedAt: new Date().toISOString(),
                instance
            });

            instance.on("response", (client, statusCode) => {
                if (statusCode >= 200 && statusCode < 300) {
                    successCount++;
                } else if (statusCode === 403 || statusCode === 429) {
                    blockedCount++;
                    if (!isStopped && !stoppedEarly) {
                        isStopped = true;
                        stoppedEarly = true;
                        stopReason = statusCode === 429
                            ? `Rate limit hit (429)`
                            : `Forbidden/WAF block detected (403)`;
                        instance.stop();
                    }
                } else {
                    otherErrorCount++;
                }
            });

            setTimeout(() => {
                if (!instance.finished && !isStopped) {
                    instance.stop();
                }
            }, (duration + 2) * 1000);
        });

        const totalAttempted = successCount + blockedCount + otherErrorCount;
        const status = stoppedEarly ? "stopped_rate_limit" : "completed";
        const throughputMb = (result.throughput?.average ?? 0) / 1024 / 1024;
        const avgLatency = result.latency?.average ?? 0;
        const maxLatency = result.latency?.max ?? 0;
        const avgReqPerSec = result.requests?.average ?? 0;
        const errorsVal = result.errors ?? 0;
        const timeoutsVal = result.timeouts ?? 0;
        const non2xxVal = (result.non2xx ?? 0) + blockedCount;

        // Save result
        await saveBenchmarkResult({
            url,
            domain,
            connections,
            duration,
            timeout,
            avgLatency,
            maxLatency,
            avgReqPerSec,
            totalRequests: totalAttempted,
            successRequests: successCount,
            blockedRequests: blockedCount,
            failedRequests: otherErrorCount,
            throughputMb,
            errors: errorsVal,
            timeouts: timeoutsVal,
            non2xx: non2xxVal,
            status,
            stopReason: stopReason || null
        });

        const latencyTable = new Table({ head: ["Metric", "Value"] });
        latencyTable.push(
            ["Average Latency", `${avgLatency.toFixed(2)} ms`],
            ["Max Latency", `${maxLatency.toFixed(2)} ms`]
        );

        const requestTable = new Table({ head: ["Metric", "Value"] });
        requestTable.push(
            ["Requests/sec", avgReqPerSec.toFixed(2)],
            ["Total Attempted", totalAttempted],
            ["Successful (2xx)", successCount],
            ["Blocked (403/429)", blockedCount],
            ["Other Errors", otherErrorCount],
            ["Throughput", `${throughputMb.toFixed(2)} MB/s`]
        );

        const errorTable = new Table({ head: ["Metric", "Count"] });
        errorTable.push(
            ["Errors", errorsVal],
            ["Timeouts", timeoutsVal],
            ["Non-2xx", non2xxVal]
        );

        let warningMsg = "";
        if (stoppedEarly) {
            warningMsg = `\nWARNING: Test stopped early: ${stopReason}\n`;
        }

        if (blockedCount > 0) {
            warningMsg += `\nRATE LIMIT / BLOCK HIT: ${blockedCount} requests returned 403 or 429\n`;
            warningMsg += `   Only ${successCount} requests were accepted.\n`;
        }

        const output = `
Running ${duration}s test @ ${url}
${connections} connections
Timeout: ${timeout}s

${latencyTable.toString()}

${requestTable.toString()}

${errorTable.toString()}${warningMsg}
`;

        res.status(200).type("text/plain").send(output);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Benchmark failed",
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

// SSE Real-Time Streaming Test Route
app.get("/api/stream-test", (req, res) => {
    const url = req.query.url as string;
    const connections = Number(req.query.connections ?? 10);
    const duration = Number(req.query.duration ?? 10);
    const timeout = Number(req.query.timeout ?? 5);
    const removeCache = req.query.removeCache === "true" || req.query.removeCache === true;

    if (!url) {
        return res.status(400).json({ error: "url query parameter required" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const testId = Date.now().toString() + Math.random().toString(36).substring(2, 5);
    const domain = extractDomain(url);
    
    let successCount = 0;
    let blockedCount = 0;
    let otherErrorCount = 0;
    let stoppedEarly = false;
    let stopReason = "";
    let isStopped = false;

    let targetUrl = url;
    const headers: Record<string, string> = {};
    let requests: any[] | undefined = undefined;

    if (removeCache) {
        headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        headers["Pragma"] = "no-cache";
        headers["Expires"] = "0";
        try {
            const parsed = new URL(url);
            const basePath = parsed.pathname + parsed.search;
            requests = [
                {
                    method: "GET",
                    path: basePath,
                    setupRequest: (req: any) => {
                        const cbVal = Date.now().toString() + Math.random().toString(36).substring(2, 5);
                        const separator = req.path.includes("?") ? "&" : "?";
                        req.path = req.path + separator + "_cb=" + cbVal;
                        return req;
                    }
                }
            ];
        } catch (e) {
            requests = [
                {
                    method: "GET",
                    path: "/",
                    setupRequest: (req: any) => {
                        const cbVal = Date.now().toString() + Math.random().toString(36).substring(2, 5);
                        const separator = req.path.includes("?") ? "&" : "?";
                        req.path = req.path + separator + "_cb=" + cbVal;
                        return req;
                    }
                }
            ];
        }
    }

    const sendSSE = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE("start", { testId, url, domain, connections, duration, timeout });

    const autocannonOpts: autocannon.Options = {
        url: targetUrl,
        connections,
        duration,
        timeout,
        headers,
    };
    if (requests) {
        autocannonOpts.requests = requests;
    }

    const instance = autocannon(
        autocannonOpts,
        (err, result) => {
            activeTests.delete(testId);

            if (err) {
                sendSSE("error", { message: err.message });
                res.end();
                return;
            }

            const totalAttempted = successCount + blockedCount + otherErrorCount;
            const status = stoppedEarly ? "stopped_rate_limit" : "completed";
            const throughputMb = (result.throughput?.average ?? 0) / 1024 / 1024;
            const avgLatency = result.latency?.average ?? 0;
            const maxLatency = result.latency?.max ?? 0;
            const avgReqPerSec = result.requests?.average ?? 0;
            const errorsVal = result.errors ?? 0;
            const timeoutsVal = result.timeouts ?? 0;
            const non2xxVal = (result.non2xx ?? 0) + blockedCount;

            saveBenchmarkResult({
                url,
                domain,
                connections,
                duration,
                timeout,
                avgLatency,
                maxLatency,
                avgReqPerSec,
                totalRequests: totalAttempted,
                successRequests: successCount,
                blockedRequests: blockedCount,
                failedRequests: otherErrorCount,
                throughputMb,
                errors: errorsVal,
                timeouts: timeoutsVal,
                non2xx: non2xxVal,
                status,
                stopReason: stopReason || null
            });

            sendSSE("complete", {
                testId,
                status,
                stopReason,
                result: {
                    totalAttempted,
                    successCount,
                    blockedCount,
                    otherErrorCount,
                    avgLatency,
                    maxLatency,
                    avgReqPerSec,
                    throughputMb,
                    errors: errorsVal,
                    timeouts: timeoutsVal,
                    non2xx: non2xxVal
                }
            });

            res.end();
        }
    );

    activeTests.set(testId, {
        id: testId,
        url,
        domain,
        connections,
        duration,
        timeout,
        startedAt: new Date().toISOString(),
        instance
    });

    instance.on("response", (client, statusCode) => {
        if (statusCode >= 200 && statusCode < 300) {
            successCount++;
        } else if (statusCode === 403 || statusCode === 429) {
            blockedCount++;
            if (!isStopped && !stoppedEarly) {
                isStopped = true;
                stoppedEarly = true;
                stopReason = statusCode === 429
                    ? `Rate limit hit (429)`
                    : `Forbidden/WAF block detected (403)`;
                instance.stop();
            }
        } else {
            otherErrorCount++;
        }
    });

    instance.on("tick", () => {
        sendSSE("tick", {
            successCount,
            blockedCount,
            otherErrorCount,
            totalAttempted: successCount + blockedCount + otherErrorCount
        });
    });

    req.on("close", () => {
        if (activeTests.has(testId)) {
            const active = activeTests.get(testId);
            if (active && active.instance) {
                active.instance.stop();
            }
            activeTests.delete(testId);
        }
    });
});

// API endpoint to retrieve active tests
app.get("/api/active-tests", (_, res) => {
    const list = Array.from(activeTests.values()).map(t => ({
        id: t.id,
        url: t.url,
        domain: t.domain,
        connections: t.connections,
        duration: t.duration,
        timeout: t.timeout,
        startedAt: t.startedAt
    }));
    res.json(list);
});

// API endpoint to fetch test history with sorting/filtering
const ALLOWED_SORT_FIELDS = [
    "id", "tested_url", "domain", "connections", "duration",
    "avg_latency", "max_latency", "avg_req_per_sec",
    "total_requests", "success_requests", "blocked_requests",
    "failed_requests", "created_at"
];

app.get("/api/history", async (req, res) => {
    const search = (req.query.search as string || "").trim();
    let sortBy = req.query.sortBy as string || "id";
    let sortOrder = req.query.sortOrder as string || "DESC";

    if (!ALLOWED_SORT_FIELDS.includes(sortBy)) {
        sortBy = "id";
    }
    const order = sortOrder.toUpperCase() === "ASC" ? 1 : -1;

    let filter: any = {};
    if (search) {
        filter.$or = [
            { tested_url: { $regex: search, $options: "i" } },
            { domain: { $regex: search, $options: "i" } }
        ];
    }

    try {
        const history = await BenchmarkHistory.find(filter)
            .sort({ [sortBy]: order });
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// API endpoint to fetch domain-merged insights
app.get("/api/domain-insights", async (req, res) => {
    const targetDomain = (req.query.domain as string || "").trim();

    try {
        if (targetDomain) {
            const statsResult = await BenchmarkHistory.aggregate([
                {
                    $match: {
                        $or: [
                            { domain: targetDomain },
                            { domain: { $regex: targetDomain, $options: "i" } }
                        ]
                    }
                },
                {
                    $group: {
                        _id: "$domain",
                        domain: { $first: "$domain" },
                        total_attacks: { $sum: 1 },
                        total_requests: { $sum: "$total_requests" },
                        success_requests: { $sum: "$success_requests" },
                        blocked_requests: { $sum: "$blocked_requests" },
                        failed_requests: { $sum: "$failed_requests" },
                        avg_latency: { $avg: "$avg_latency" },
                        max_latency: { $max: "$max_latency" },
                        avg_req_per_sec: { $avg: "$avg_req_per_sec" },
                        avg_throughput_mb: { $avg: "$throughput_mb" }
                    }
                }
            ]);
            
            const stats = statsResult[0] || null;

            const historyPoints = await BenchmarkHistory.find({
                $or: [
                    { domain: targetDomain },
                    { domain: { $regex: targetDomain, $options: "i" } }
                ]
            })
            .sort({ id: 1 })
            .select("id created_at avg_req_per_sec avg_latency success_requests blocked_requests failed_requests");

            res.json({ stats, historyPoints });
        } else {
            const allStats = await BenchmarkHistory.aggregate([
                {
                    $group: {
                        _id: "$domain",
                        domain: { $first: "$domain" },
                        total_attacks: { $sum: 1 },
                        total_requests: { $sum: "$total_requests" },
                        success_requests: { $sum: "$success_requests" },
                        blocked_requests: { $sum: "$blocked_requests" },
                        failed_requests: { $sum: "$failed_requests" },
                        avg_latency: { $avg: "$avg_latency" },
                        max_latency: { $max: "$max_latency" },
                        avg_req_per_sec: { $avg: "$avg_req_per_sec" }
                    }
                },
                { $sort: { total_requests: -1 } }
            ]);
            res.json(allStats);
        }
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// API endpoint for dashboard global performance statistics
app.get("/api/global-stats", async (_, res) => {
    try {
        const avgLatencyResult = await BenchmarkHistory.aggregate([
            { $match: { status: "completed", avg_latency: { $gt: 0 } } },
            { $group: { _id: null, val: { $avg: "$avg_latency" } } }
        ]);

        const totalBandwidthResult = await BenchmarkHistory.aggregate([
            { $group: { _id: null, val: { $sum: { $multiply: ["$throughput_mb", "$duration"] } } } }
        ]);

        const blockRateResult = await BenchmarkHistory.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: "$total_requests" },
                    blocked: { $sum: "$blocked_requests" }
                }
            }
        ]);

        const totalBenchmarks = await BenchmarkHistory.countDocuments();
        
        const hitsResult = await ApiStat.aggregate([
            { $group: { _id: null, total: { $sum: "$hits" } } }
        ]);

        const distinctDomains = await BenchmarkHistory.distinct("domain");

        let blockRate = 0;
        if (blockRateResult[0] && blockRateResult[0].total > 0) {
            blockRate = (blockRateResult[0].blocked * 100) / blockRateResult[0].total;
        }

        res.json({
            globalLatency: avgLatencyResult[0]?.val ?? 0,
            totalBandwidth: totalBandwidthResult[0]?.val ?? 0,
            wafBlockRate: blockRate,
            totalBenchmarks,
            totalHits: hitsResult[0]?.total ?? 0,
            totalDomains: distinctDomains.length
        });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/analytics", async (_, res) => {
    try {
        const routes = await ApiStat.find().sort({ hits: -1 });
        res.json(routes);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/history", async (_, res) => {
    try {
        const history = await BenchmarkHistory.find().sort({ id: -1 }).limit(100);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get("/stats", async (_, res) => {
    try {
        const hitsResult = await ApiStat.aggregate([
            { $group: { _id: null, total: { $sum: "$hits" } } }
        ]);
        const totalBenchmarks = await BenchmarkHistory.countDocuments();
        res.json({
            totalApiHits: hitsResult[0]?.total ?? 0,
            totalBenchmarks
        });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// Authentication middleware for admin endpoints
const adminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const password = req.headers["x-admin-password"] || req.query.password;
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
    if (password !== adminPassword) {
        return res.status(401).send("Unauthorized: Invalid admin password.");
    }
    next();
};

// Admin verify route
app.get("/api/admin/verify", adminAuth, (_, res) => {
    res.json({ success: true, instanceId });
});

// Admin raw-logs route - returns the raw metrics.log file content
app.get("/api/admin/raw-logs", adminAuth, (_, res) => {
    try {
        if (fs.existsSync(logFilePath)) {
            const rawLogs = fs.readFileSync(logFilePath, "utf8");
            res.type("text/plain").send(rawLogs);
        } else {
            res.type("text/plain").send("");
        }
    } catch (err) {
        res.status(500).send("Error reading logs: " + (err as Error).message);
    }
});

// Admin sync-logs route - fetches raw logs from all replica instances, merges them, and returns grouped data
app.get("/api/admin/sync-logs", adminAuth, async (req, res) => {
    const password = req.headers["x-admin-password"] || req.query.password;
    const urlsEnv = process.env.INSTANCE_URLS || "";
    const instanceUrls = urlsEnv
        .split(",")
        .map(u => u.trim())
        .filter(u => u.length > 0);

    const mergedFilePath = path.join(__dirname, "merged_metrics.log");
    let allLogLines: string[] = [];

    // 1. Read local logs first
    try {
        if (fs.existsSync(logFilePath)) {
            const localRaw = fs.readFileSync(logFilePath, "utf8").trim();
            if (localRaw) {
                allLogLines.push(...localRaw.split("\n"));
            }
        }
    } catch (err) {
        console.error("Error reading local logs for sync:", err);
    }

    // 2. Fetch remote replica logs in parallel (if configured)
    if (instanceUrls.length > 0) {
        const fetchPromises = instanceUrls.map(async (url) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000); // 3-second timeout

                const reqUrl = `${url.replace(/\/$/, "")}/api/admin/raw-logs?password=${encodeURIComponent(String(password))}`;
                const response = await fetch(reqUrl, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (response.ok) {
                    const text = await response.text();
                    return text.trim();
                }
            } catch (err) {
                console.error(`Failed to fetch logs from replica ${url}:`, (err as Error).message);
            }
            return "";
        });

        const results = await Promise.allSettled(fetchPromises);
        for (const res of results) {
            if (res.status === "fulfilled" && res.value) {
                allLogLines.push(...res.value.split("\n"));
            }
        }
    }

    // 3. De-duplicate and sort lines by timestamp to build a clean merged log
    const logMap = new Map<string, any>();
    for (const line of allLogLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const entry = JSON.parse(trimmed);
            if (entry.instanceId && entry.timestamp) {
                // Key on instanceId + timestamp to de-duplicate logs
                const key = `${entry.instanceId}-${entry.timestamp}`;
                logMap.set(key, entry);
            }
        } catch (e) {
            // Ignore corrupted lines
        }
    }

    const sortedEntries = Array.from(logMap.values()).sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // 4. Save merged logs to file
    try {
        const mergedContent = sortedEntries.map(e => JSON.stringify(e)).join("\n") + "\n";
        fs.writeFileSync(mergedFilePath, mergedContent, "utf8");
    } catch (err) {
        console.error("Error writing merged_metrics.log:", err);
    }

    // 5. Group entries by instanceId for the client dashboard
    const groupedNodes: Record<string, any[]> = {};
    for (const entry of sortedEntries) {
        if (!groupedNodes[entry.instanceId]) {
            groupedNodes[entry.instanceId] = [];
        }
        groupedNodes[entry.instanceId].push(entry);
    }

    res.json({ nodes: groupedNodes });
});

// Admin clear benchmark history
app.post("/api/admin/clear-history", adminAuth, async (_, res) => {
    try {
        await BenchmarkHistory.deleteMany({});
        res.json({ success: true, message: "Benchmark history cleared successfully." });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

// Admin stop benchmark test
app.post("/api/admin/stop-test", adminAuth, (req, res) => {
    const testId = req.query.id as string;
    if (!testId) {
        return res.status(400).send("testId query parameter required");
    }

    if (activeTests.has(testId)) {
        const active = activeTests.get(testId);
        if (active && active.instance) {
            active.instance.stop();
        }
        activeTests.delete(testId);
        res.json({ success: true, message: `Active test ${testId} stopped successfully.` });
    } else {
        res.status(404).send(`Active test ${testId} not found.`);
    }
});

// Process global error handling to prevent server crashes
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception thrown:", error);
});

// Connect to Database first then start listening
connectDB().then(() => {
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on port ${PORT}`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
});
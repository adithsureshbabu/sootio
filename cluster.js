#!/usr/bin/env node

import 'dotenv/config';
import cluster from 'cluster';
import os from 'os';
import { overrideConsole } from './lib/util/logger.js';
import { memoryMonitor } from './lib/util/memory-monitor.js';

// Override console to respect LOG_LEVEL environment variable
overrideConsole();

// CRITICAL: Global error handlers to prevent memory leaks from unhandled errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Promise Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (error) => {
    console.error('[CRITICAL] Uncaught Exception:', error?.message || error);
});

const numCPUs = os.cpus().length;
const totalMemoryGB = os.totalmem() / (1024 ** 3);

// Worker calculation for I/O-bound workloads (web servers benefit from more workers than CPUs)
// Formula: base on CPU count with I/O multiplier, constrained by memory (each worker ~150-300MB)
const memoryPerWorkerGB = 0.25; // Conservative estimate per worker
const maxWorkersByMemory = Math.floor(totalMemoryGB / memoryPerWorkerGB * 0.7); // Use 70% of memory max
const ioMultiplier = parseFloat(process.env.WORKER_IO_MULTIPLIER) || 2; // I/O bound apps benefit from 2-4x CPUs
const calculatedWorkers = Math.ceil(numCPUs * ioMultiplier);

// Environment overrides for fine-tuning
const envMaxWorkers = parseInt(process.env.MAX_WORKERS, 10) || 128;
const envMinWorkers = parseInt(process.env.MIN_WORKERS, 10) || numCPUs;

// Final worker count: balance CPU multiplier, memory limits, and env config
const workersToUse = Math.max(
    envMinWorkers,
    Math.min(calculatedWorkers, maxWorkersByMemory, envMaxWorkers)
);

// UV_THREADPOOL_SIZE optimization for high I/O throughput
// Scale aggressively for I/O-bound workloads, capped at 1024 (libuv max)
const threadPoolSize = parseInt(process.env.UV_THREADPOOL_SIZE, 10) ||
    Math.max(32, Math.min(numCPUs * 8, 1024));
process.env.UV_THREADPOOL_SIZE = threadPoolSize;

// Enable round-robin scheduling for better load distribution across workers
cluster.schedulingPolicy = cluster.SCHED_RR;

if (cluster.isMaster) {
    console.log(`Master process ${process.pid} is running`);
    console.log(`System: ${numCPUs} CPUs, ${totalMemoryGB.toFixed(1)}GB RAM`);
    console.log(`Workers: ${workersToUse} (calculated: ${calculatedWorkers}, memory-limited: ${maxWorkersByMemory})`);
    console.log(`Thread pool: ${process.env.UV_THREADPOOL_SIZE} | Scheduling: Round-Robin`);
    console.log(`Config: MIN_WORKERS=${envMinWorkers}, MAX_WORKERS=${envMaxWorkers}, IO_MULTIPLIER=${ioMultiplier}`);

    // Start memory monitoring in master process
    memoryMonitor.startMonitoring();

    // Track worker restarts for crash loop detection
    const workerRestarts = new Map(); // pid -> { count, lastRestart }
    const RESTART_WINDOW_MS = 60000; // 1 minute window
    const MAX_RESTARTS_PER_WINDOW = 5;
    const RESTART_BACKOFF_MS = 2000; // Base backoff delay

    // Fork workers with staggered startup to reduce initial load spike
    const STAGGER_DELAY_MS = 50;
    let workersStarted = 0;

    const forkWorker = () => {
        const worker = cluster.fork();
        workersStarted++;
        console.log(`Worker ${workersStarted}/${workersToUse} started (PID: ${worker.process.pid})`);
        return worker;
    };

    // Staggered worker startup
    for (let i = 0; i < workersToUse; i++) {
        setTimeout(() => forkWorker(), i * STAGGER_DELAY_MS);
    }

    // Handle worker exits with crash loop protection
    cluster.on('exit', (worker, code, signal) => {
        const pid = worker.process.pid;
        const now = Date.now();

        console.log(`Worker ${pid} exited (code: ${code}, signal: ${signal})`);

        // Track restarts for crash loop detection
        let restartInfo = workerRestarts.get(pid) || { count: 0, lastRestart: 0 };

        // Reset counter if outside window
        if (now - restartInfo.lastRestart > RESTART_WINDOW_MS) {
            restartInfo = { count: 0, lastRestart: now };
        }

        restartInfo.count++;
        restartInfo.lastRestart = now;
        workerRestarts.set(pid, restartInfo);

        // Calculate backoff delay based on restart count
        const backoffDelay = Math.min(
            RESTART_BACKOFF_MS * Math.pow(2, restartInfo.count - 1),
            30000 // Max 30 second backoff
        );

        if (restartInfo.count > MAX_RESTARTS_PER_WINDOW) {
            console.error(`Worker crash loop detected (${restartInfo.count} restarts in ${RESTART_WINDOW_MS}ms). Delaying restart by ${backoffDelay}ms`);
        }

        // Restart worker with backoff
        setTimeout(() => {
            console.log('Starting replacement worker...');
            cluster.fork();
        }, restartInfo.count > 1 ? backoffDelay : 100);

        // Cleanup old restart tracking entries
        for (const [oldPid, info] of workerRestarts.entries()) {
            if (now - info.lastRestart > RESTART_WINDOW_MS * 2) {
                workerRestarts.delete(oldPid);
            }
        }
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nShutting down master process...');
        memoryMonitor.stopMonitoring(); // Stop memory monitoring
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGTERM');
        }
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        memoryMonitor.stopMonitoring(); // Stop memory monitoring
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGTERM');
        }
        process.exit(0);
    });
} else {
    // Worker processes
    console.log(`Worker ${process.pid} started`);

    // Import server.js and start the server explicitly in worker process
    let sqliteCache = null;
    let sqliteHashCache = null;
    let cacheDb = null;
    let rdRateLimiter = null;
    let adRateLimiter = null;
    let proxyManager = null;
    let personalFilesCache = null;
    let serverInstance = null;

    try {
        const serverModule = await import('./server.js');
        const { app, server, PORT, HOST } = serverModule;

        // Import SQLite modules for cleanup
        sqliteCache = await import('./lib/util/cache-store.js');
        sqliteHashCache = await import('./lib/util/hash-cache-store.js');

        // Import rate limiters for cleanup
        rdRateLimiter = (await import('./lib/util/rd-rate-limit.js')).default;
        adRateLimiter = (await import('./lib/util/ad-rate-limit.js')).default;

        // Import proxy manager for cleanup
        proxyManager = (await import('./lib/util/proxy-manager.js')).default;

        // Import personal files cache for cleanup
        personalFilesCache = (await import('./lib/util/personal-files-cache.js')).default;

        // Get server instance from server module
        serverInstance = server;

        // Start memory monitoring in worker process
        memoryMonitor.startMonitoring();

        // Start server in worker if it's not already started
        if (!server || server === null) {
            const port = PORT;
            const host = HOST;

            const workerServer = app.listen(port, host, () => {
                console.log(`Worker ${process.pid} server listening on port ${port}`);
            });

            // Tune HTTP server for high concurrency
            workerServer.keepAliveTimeout = 65000; // Slightly higher than typical LB timeout (60s)
            workerServer.headersTimeout = 66000; // Must be > keepAliveTimeout
            workerServer.maxConnections = 0; // Unlimited connections per worker
            workerServer.timeout = 120000; // 2 minute request timeout

            // Export server for the worker process to use for cleanup
            global.workerServer = workerServer;
        } else {
            console.log(`Worker ${process.pid} using existing server on port ${PORT}`);
            // Apply same tuning to existing server
            if (server) {
                server.keepAliveTimeout = 65000;
                server.headersTimeout = 66000;
                server.maxConnections = 0;
                server.timeout = 120000;
            }
        }
    } catch (error) {
        console.error(`Worker ${process.pid} failed to start:`, error);
        process.exit(1);
    }

    // Handle graceful shutdown for workers
    let workerShuttingDown = false;

    const gracefulWorkerShutdown = async (signal) => {
        if (workerShuttingDown) return;
        workerShuttingDown = true;

        console.log(`Worker ${process.pid} received ${signal}, shutting down gracefully...`);

        // Shutdown rate limiters, proxy manager, and caches to clear intervals
        try {
            if (rdRateLimiter) rdRateLimiter.shutdown();
            if (adRateLimiter) adRateLimiter.shutdown();
            if (proxyManager) proxyManager.shutdown();
            if (personalFilesCache) personalFilesCache.shutdown();
            console.log(`Worker ${process.pid} rate limiters, proxy manager, and cache intervals cleared`);
        } catch (error) {
            console.error(`Worker ${process.pid} Error shutting down rate limiters/proxy/cache: ${error.message}`);
        }

        // Close SQLite connections
        try {
            if (sqliteCache && sqliteHashCache) {
                await Promise.all([
                    sqliteCache.closeSqlite(),
                    sqliteHashCache.closeConnection()
                ]);
                console.log(`Worker ${process.pid} SQLite connections closed`);
            }
        } catch (error) {
            console.error(`Worker ${process.pid} Error closing SQLite: ${error.message}`);
        }

        // Stop memory monitoring
        memoryMonitor.stopMonitoring();

        // Close HTTP server
        if (global.workerServer) {
            global.workerServer.close(() => {
                console.log(`Worker ${process.pid} server closed`);
                process.exit(0);
            });

            // Force exit after 5 seconds
            setTimeout(() => {
                console.error(`Worker ${process.pid} forced shutdown`);
                process.exit(1);
            }, 5000).unref();
        } else {
            process.exit(0);
        }
    };

    process.on('SIGINT', () => gracefulWorkerShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulWorkerShutdown('SIGTERM'));
}

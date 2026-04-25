# HTTP Streams Health Check Service

Automated twice-daily monitoring of HTTP stream providers with status reporting.

## Overview

The health check script (`scripts/test-http-streams-status.mjs`) tests all 10 HTTP providers against a common test movie (The Godfather) and generates a status report.

## Output Files

- **`/http-streams-status`** - Markdown report (human-readable)
- **`/http-streams-status.json`** - JSON report (machine-readable)

## Status Report

The markdown report includes:
- **Last Updated** - Timestamp of most recent test
- **Summary** - Working/failed/no-content counts and success rate
- **Provider Status** - Grouped by status with stream counts or error messages

Example:
```
# HTTP Streams Health Report

**Last Updated:** Apr 10, 2026 7:45 PM
**Test Content:** The Godfather (tt0068646)

## Summary
- ✅ **Working:** 6/10
- ⚠️ **No Content:** 2/10
- ❌ **Failed:** 2/10
- 📊 **Success Rate:** 60%

## Provider Status

### ✅ Working
- **4KHDHub** - 8 streams found
- **MalluMv** - 3 streams found
- ...
```

## Setup Options

### Option 1: System Cron (Recommended for Production)

Add to `/etc/cron.d/sootio-health-check`:
```cron
0 6 * * * ubuntu npm run health-check >> /var/log/sootio-health.log 2>&1
0 18 * * * ubuntu cd /home/ubuntu/sootio-stremio-addon && npm run health-check >> /var/log/sootio-health.log 2>&1
```

Add to `package.json`:
```json
{
  "scripts": {
    "health-check": "node scripts/test-http-streams-status.mjs"
  }
}
```

### Option 2: Systemd Timer

Create `/etc/systemd/system/sootio-health.service`:
```ini
[Unit]
Description=Sootio HTTP Streams Health Check
After=network.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/sootio-stremio-addon
ExecStart=/usr/bin/node scripts/test-http-streams-status.mjs
StandardOutput=journal
StandardError=journal
```

Create `/etc/systemd/system/sootio-health.timer`:
```ini
[Unit]
Description=Run Sootio HTTP Health Check twice daily
Requires=sootio-health.service

[Timer]
OnCalendar=*-*-* 06:00:00
OnCalendar=*-*-* 18:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sootio-health.timer
```

### Option 3: Docker Container (if using Docker)

Add to docker-compose.yml or your container:
```yaml
  health-check:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - .:/app
      - /http-streams-status:/http-streams-status
    entrypoint: |
      sh -c "
      while true; do
        node scripts/test-http-streams-status.mjs
        sleep $((12 * 3600))  # Sleep 12 hours between checks (runs at 6am/6pm)
      done
      "
```

## Monitoring the Status

### View Current Status
```bash
cat /http-streams-status
```

### View JSON for Alerts
```bash
cat /http-streams-status.json | jq '.summary'
```

### Check Success Rate
```bash
grep "Success Rate" /http-streams-status
```

## Integration with Monitoring

### Prometheus (export metrics)
You could extend the script to export to Prometheus format:
```bash
# /http-streams-status.prom
http_streams_working{provider="4khdhub"} 8
http_streams_working{provider="mallumv"} 3
http_streams_success_rate 0.60
```

### Email/Slack Alerts
Wrap the script with a notification layer:
```bash
#!/bin/bash
node scripts/test-http-streams-status.mjs
STATUS=$?

if [ $STATUS -ne 0 ]; then
  curl -X POST webhook_url -d "HTTP streams health check failed"
fi
```

## Customization

Edit `scripts/test-http-streams-status.mjs` to:

1. **Change test content:**
   ```javascript
   const TEST_MOVIE = {
     imdbId: 'tt1375666',  // Inception instead
     title: 'Inception',
     type: 'movie'
   };
   ```

2. **Add/remove providers:**
   ```javascript
   const PROVIDERS = [
     { name: 'CineDoze', fn: getCineDozeStreams },
     // Remove or add providers
   ];
   ```

3. **Change timeout:**
   ```javascript
   const timeout = 60000;  // 60 seconds instead of 30
   ```

## Troubleshooting

### Status file not created
- Check /var/log/sootio-health.log for errors
- Ensure script has write permissions to /
- Run manually: `node scripts/test-http-streams-status.mjs`

### Some providers always fail
- This is expected if the provider is down
- Check error message in JSON report
- Test manually with: `npm run test -- tests/4khdhub.test.js`

### Performance issues
- Reduce number of providers tested
- Increase timeout per provider
- Run tests at off-peak hours

## Viewing Results Over Time

The status file is overwritten each run. For history, pipe to a log:
```bash
# Append with timestamp
node scripts/test-http-streams-status.mjs >> health-history.log

# Or with jq for JSON history
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $(cat /http-streams-status.json | jq '.summary')" >> health-history.json
```

# Running multiple simulator instances

This guide explains how to run multiple charging point simulators simultaneously, which is useful for testing scenarios with multiple charge points.

## Overview

Each simulator instance requires:
- A unique `CP_ID` (Charge Point ID)
- A unique `ADMIN_PORT` for the second and subsequent instances (the first instance uses the default port)

## Running two simulators

### Step 1: Start the first simulator

Run the first simulator with default settings:

```bash
WS_URL=wss://server.16.ocpp.sdbx.solid.oreve.com CP_ID=FR*ORV*B0017 PASSWORD=OREVE123 npx tsx index_16.ts
```

### Step 2: Start the second simulator

In a new terminal, run the second simulator with a different `CP_ID` and a custom `ADMIN_PORT`:

```bash
ADMIN_PORT=9998 WS_URL=wss://server.16.ocpp.sdbx.solid.oreve.com CP_ID=FR*ORV*B0016 PASSWORD=OREVE123 npx tsx index_16.ts
```

## Executing admin commands

### For the first simulator (default port)

Admin commands for the first simulator work without specifying a port:

```bash
npx tsx admin/v16/Authorize/authorize.ts
```

### For the second simulator (custom port)

**Important:** When executing admin commands for the second simulator instance, you must include the `ADMIN_PORT` environment variable:

```bash
ADMIN_PORT=9998 npx tsx admin/v16/Authorize/authorize.ts
```

## Example: Running a complete two-simulator setup

### Terminal 1 - First simulator
```bash
WS_URL=wss://server.16.ocpp.sdbx.solid.oreve.com CP_ID=FR*ORV*B0017 PASSWORD=OREVE123 npx tsx index_16.ts
```

### Terminal 2 - Second simulator
```bash
ADMIN_PORT=9998 WS_URL=wss://server.16.ocpp.sdbx.solid.oreve.com CP_ID=FR*ORV*B0016 PASSWORD=OREVE123 npx tsx index_16.ts
```

### Terminal 3 - Send commands to first simulator
```bash
# Send authorize on first simulator
npx tsx admin/v16/Authorize/authorize.ts

# Start transaction on first simulator
npx tsx admin/v16/Transaction/startTransaction.ts
```

### Terminal 4 - Send commands to second simulator
```bash
# Send authorize on second simulator (note the ADMIN_PORT)
ADMIN_PORT=9998 npx tsx admin/v16/Authorize/authorize.ts

# Start transaction on second simulator (note the ADMIN_PORT)
ADMIN_PORT=9998 npx tsx admin/v16/Transaction/startTransaction.ts
```

## Scaling to more simulators

For additional simulator instances, simply use different `ADMIN_PORT` values:

| Instance | CP_ID | ADMIN_PORT |
|----------|-------|------------|
| 1st | FR*ORV*B0017 | (default) |
| 2nd | FR*ORV*B0016 | 9998 |
| 3rd | FR*ORV*B0015 | 9997 |
| 4th | FR*ORV*B0014 | 9996 |

## Troubleshooting

### Port already in use
If you see an error about the port being in use, ensure:
- No other process is using the admin port
- Each simulator instance has a unique `ADMIN_PORT`

### Commands going to wrong simulator
Always double-check that you're using the correct `ADMIN_PORT` when sending commands. Commands without `ADMIN_PORT` will go to the first simulator instance.


# Stage 11 — Local runtime preflight and three-device acceptance

## Scope
This stage adds a repeatable local preflight for the laptop and each Android/Termux installation. It does not claim that physical devices or peer-to-peer synchronization have passed.

## Run on each device
1. Install a supported Node.js LTS release, Git, and npm (on Android, use Termux).
2. Obtain the same reviewed project revision using the approved private-repository authentication method.
3. Run `npm install`.
4. Run `bash scripts/verify-local-runtime.sh`.
5. Record the device label, OS/Android version, Node/npm versions, result, and log output. Do not record tokens, passwords, or shared secrets.

The preflight builds the PWA, starts the existing Express server on port 3187 (override with `PORT` if needed), checks `GET /api/health`, validates its JSON payload, and stops the process it started.

## Physical acceptance matrix — still requires the owner's devices
| Check | Laptop | Mehran phone | Ehsan phone |
|---|---|---|---|
| Install dependencies | Pending | Pending | Pending |
| Production build | Pending | Pending | Pending |
| Express health endpoint | Pending | Pending | Pending |
| Local data survives app restart | Pending | Pending | Pending |
| Unique device identity verified | Pending | Pending | Pending |
| PeerJS signaling and direct connection | Pending | Pending | Pending |
| Create a harmless test record and receive it exactly once | Pending | Pending | Pending |
| Disconnect/reconnect and outbox recovery | Pending | Pending | Pending |
| Conflict handling and duplicate prevention | Pending | Pending | Pending |
| Android background/Doze behavior | N/A | Pending | Pending |

## Safety gates
- Use synthetic test records only; do not test with live accounting documents.
- Do not expose port 3000/3187 to the public internet.
- Do not treat a successful HTTP health check as proof that PeerJS signaling, WebRTC, persistence, or three-device synchronization works.
- Keep `main` unchanged until all three devices pass the acceptance matrix and the synchronization/security review is complete.

## Known blockers carried forward
- The earlier preparation PR #1 was closed without merging; its Android launcher and documentation are not part of `main`.
- The current fixed device profile list labels the phones as Mehran's phone and a colleague's phone. Confirm the intended ownership labels before changing persisted device IDs.
- The current PeerJS setup uses its default signaling service; independent signaling and TURN/NAT coverage are not yet verified.
- Termux background execution and reboot recovery are not implemented by the earlier launcher script.

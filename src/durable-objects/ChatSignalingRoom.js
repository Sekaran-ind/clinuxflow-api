// Pure WebRTC signaling relay for P2P user-to-user chat — see
// docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md and GET /api/chat/signal in src/index.js.
//
// This object's ONLY job is forwarding opaque SDP offer/answer and ICE-candidate blobs between
// the two WebSockets connected to it, so the two browsers can negotiate a direct
// RTCPeerConnection DataChannel. It never parses, inspects, or persists what it relays — no
// state.storage calls anywhere in this file — and once the DataChannel is open, actual chat
// messages flow browser-to-browser and never reach this object (or any server) again. That's
// what makes "nothing stored in the interim" true at the transport level, not just "we don't
// write it to a database."
//
// One instance per unordered pair of accounts (see chatRoomName() in src/index.js) — Cloudflare
// routes both participants' WebSocket upgrades to the SAME instance via idFromName(), so no
// shared registry/pub-sub is needed to find "the other side." At most 2 sockets are ever
// tracked; a 3rd connection attempt is rejected rather than silently dropping someone.
export class ChatSignalingRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sockets = new Set();
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 });
        }
        if (this.sockets.size >= 2) {
            return new Response('This chat already has two active participants.', { status: 409 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();

        // Tell whichever socket completes the pair which side should send the SDP offer first —
        // otherwise both peers might invent an offer simultaneously ("glare") with no protocol
        // to resolve it. The one that was already waiting alone answers; the one that just
        // completed the pair initiates. The lone first connection gets nothing yet — there's no
        // one to negotiate with until a second socket shows up.
        const wasAlreadyOnePresent = this.sockets.size === 1;
        this.sockets.add(server);
        if (wasAlreadyOnePresent) {
            for (const peer of this.sockets) {
                const isNewcomer = peer === server;
                peer.send(JSON.stringify({ type: 'ready', initiator: isNewcomer }));
            }
        }

        server.addEventListener('message', (event) => {
            for (const peer of this.sockets) {
                if (peer !== server && peer.readyState === WebSocket.READY_STATE_OPEN) {
                    peer.send(event.data);
                }
            }
        });

        const leave = () => {
            this.sockets.delete(server);
            for (const peer of this.sockets) {
                if (peer.readyState === WebSocket.READY_STATE_OPEN) peer.send(JSON.stringify({ type: 'peer-left' }));
            }
        };
        server.addEventListener('close', leave);
        server.addEventListener('error', leave);

        return new Response(null, { status: 101, webSocket: client });
    }
}

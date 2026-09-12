# Your AI Assistant Shouldn't Live on Someone Else's Server

**And it definitely shouldn't be trapped on a single device.**

---

A few months ago I introduced Aurora, my open-source privacy-first voice assistant, as a response to a growing frustration: every modern AI assistant either ships your data to the cloud, charges you a monthly fortune, or gives you the intelligence of a kitchen timer.

Since then the project has evolved significantly, and I believe the latest direction tackles what might be the single biggest unsolved problem in private AI: **how do you get the power of a distributed system without handing over control to someone else?**

## The Problem Nobody is Talking About

Running a capable AI assistant locally is no longer science fiction. You can run wake word detection, speech-to-text, text-to-speech, embeddings, and even decent LLMs on consumer hardware. I demonstrated all of this in Aurora's first release.

But here's the catch that nobody wants to admit: a single device is a ceiling.

Your phone doesn't have the GPU to run a decent LLM. Your desktop does, but it's in another room. Your Raspberry Pi makes a perfect always-on microphone, but it can barely run the transcription model. And if you want your assistant available across your home, your office, and your phone while commuting — you're back to needing some kind of distributed architecture.

And what does the industry offer you? Cloud APIs. Subscriptions. "Trust us with your data."

I wanted a third option.

## Aurora Mesh: Your Private AI Network

The latest architecture overhaul transforms Aurora from a standalone assistant into a **peer-to-peer mesh network** where your own devices collaborate to form a private AI cloud.

The idea is deceptively simple: if your desktop has a powerful GPU, let it be the "brain." If your Raspberry Pi has a microphone, let it be the "ears." If your phone is in your pocket, let it be a lightweight client. But — and this is the important part — **you** decide what gets shared, what gets consumed, and who gets access to what.

No central server. No cloud relay for your actual data. No corporate middleman.

### How It Actually Works

Aurora was already built as a microservices architecture internally. Every capability — speech-to-text, text-to-speech, orchestration, tooling, database — is an independent service communicating through a message bus. This wasn't accidental; it was designed from day one with distribution in mind.

The key insight was: if services already communicate via typed messages and explicit contracts, then routing those messages to a remote device instead of a local handler is just a configuration change.

This is exactly what the new **MeshBus** does. It sits on top of the existing message bus and intercepts every message. Based on a routing table you configure, it decides: should this go to a local service or to a remote peer?

```
Instance A (Raspberry Pi)              Instance B (Desktop with GPU)
─────────────────────────              ──────────────────────────────
Microphone → Wake Word Detection
  → Speech-to-Text (local, lightweight)
    → "Hey Aurora, summarize my emails"
      → Orchestrator: route=network ──────► Orchestrator (local, powerful GPU)
                                              → LLM processes request
                                              → Calls email tool
                                            ◄── Result forwarded back
      ← TTS speaks the summary
```

From the user's perspective, it's seamless. You speak to the Pi, the heavy lifting happens on your desktop, and the response comes back through the Pi's speakers. But crucially: that audio, that transcript, that email content — it never left your network.

## You Decide What to Share

One of the design principles I felt most strongly about is **selective sharing**. Most distributed systems have an all-or-nothing approach. You either expose a service or you don't.

Aurora takes a different path. The configuration separates two distinct concerns:

**Sharing Policy** — what you offer to the network:

```json
{
  "Orchestrator": { "share": true, "max_concurrent": 2 },
  "TTS": { "share": true, "max_concurrent": 10 },
  "DB": { "share": false }
}
```

**Routing Preference** — what you consume from the network:

```json
{
  "Orchestrator": { "prefer": "network", "fallback": "local" },
  "TTS": { "prefer": "local" },
  "DB": { "prefer": "local" }
}
```

Your desktop might share its Orchestrator (GPU-heavy LLM inference) and TTS (high-quality voice synthesis) while keeping its database strictly local. Your phone might consume the Orchestrator from the network but handle its own wake word detection locally because latency matters there.

This granularity means you can build exactly the topology you want. A family could have one powerful server in the house sharing LLM and TTS, with lightweight clients in every room. A developer could share their work machine's capabilities with their phone for on-the-go access. Two friends could even pool their hardware to get better performance than either could achieve alone.

## Security: Trust is Earned, Not Assumed

Exposing services over a network — even your home network — without proper security would be reckless. Aurora's mesh implements a full **principal-based RBAC (Role-Based Access Control)** system inspired by how enterprise systems handle identity, but adapted for personal use.

### Pairing: The Bluetooth Model

When a new device wants to join your mesh, it goes through a pairing flow similar to Bluetooth:

1. The new device requests to pair and receives a 6-digit code
2. The code is displayed on the device
3. You (the admin) approve it from an already-trusted device, optionally restricting permissions
4. A bearer token is issued, scoped to exactly the permissions you granted

No passwords flying around. No pre-shared keys to manage. Just a simple handshake you physically verify.

### Granular Permissions

Every action in the mesh is gated by permissions. When you approve a device, you can grant exactly the access it needs:

- Your living room speaker might get `TTS.*` and `STT.*` (it can listen and speak) but not `DB.*` (it can't touch your data)
- Your phone gets `chat.send` and `Orchestrator.*` (it can ask questions) plus `Scheduler.*` (it can set reminders)
- A friend's device that you've paired for resource sharing might only get `TTS.Request` (it can use your TTS engine, nothing else)

**Effective permissions** are always the intersection of what the user is allowed and what the token is scoped for. Belt and suspenders.

### Bilateral Trust

Mesh pairing is **bilateral**. When two Aurora instances connect, each side independently decides what to share with the other. Instance A approving Instance B does not mean B automatically trusts A. Both sides go through the pairing flow. Both sides set their own permissions.

This is a conscious design choice. In a world where even "trusted" devices can be compromised, unilateral trust is a liability.

## The Transport: WebRTC

For the actual peer-to-peer communication, Aurora uses **WebRTC DataChannels**. This was a deliberate choice over alternatives like plain WebSockets or custom protocols, for several reasons:

- **End-to-end encryption by default** — even the signaling server (used only for the initial handshake) cannot read your data
- **NAT traversal built in** — STUN/TURN handles the networking headaches so your devices can find each other across different networks without you setting up port forwarding or VPNs
- **Battle-tested** — WebRTC powers video calls for billions of people; the protocol is mature and well-understood
- **Low latency** — DataChannels use SCTP over DTLS, optimized for real-time communication

The actual data flowing between peers is JSON-RPC over these encrypted channels. When your Pi asks your desktop's Orchestrator to process a request, it's a structured RPC call with typed input/output schemas — the same contracts that services use internally.

## Graceful Degradation

Here's something I learned the hard way building this: distributed systems fail. Networks drop. Devices go to sleep. Docker containers restart.

Aurora's mesh was designed with this reality in mind. Every routing configuration has a **fallback**:

```json
{ "prefer": "network", "fallback": "local" }
```

If your desktop goes offline, your Pi doesn't just stop working. It falls back to local processing. Sure, the local LLM on a Pi might be slower or less capable, but your assistant stays functional. When the desktop comes back, routing seamlessly switches back to the network.

Services also exchange **capability manifests** when they connect — declaring their version, supported features, and capacity limits. If a peer's version is incompatible, the connection is rejected cleanly instead of producing mysterious errors.

## What This Means for the Future of Private AI

I believe we're at an inflection point. The hardware is getting there — local LLMs are improving at a staggering rate, and specialized AI chips are appearing in consumer devices. The models are getting there — smaller, more efficient, better at specific tasks.

What's been missing is the **architecture** to tie it all together without sacrificing privacy.

The centralized model (everything in the cloud) is convenient but comes with an inherent privacy cost that many people are no longer willing to pay. The fully-local model (everything on one device) is private but limited.

The peer-to-peer mesh model is the sweet spot: **distributed power, local control**. Your data flows between your devices, encrypted end-to-end, with access controls you define. Your compute scales with your hardware. Your assistant improves as you add devices instead of as you increase your subscription tier.

This isn't just about voice assistants. The same architectural pattern — contract-based services, transparent routing, bilateral trust, selective sharing — can apply to any AI workload that people want to keep private while still benefiting from distributed processing.

## Where Aurora Stands Today

The mesh architecture is implemented and functional. You can:

- **Pair devices** through the Bluetooth-style flow with granular RBAC
- **Share specific services** across your devices with capacity limits
- **Route requests** to local or remote providers with automatic fallback
- **Monitor your mesh** through the Gateway API and Tilt development UI
- **Run in any topology** — fully local (threads mode), containerized microservices (process mode), or distributed mesh (P2P mode)

The project is also now running in Docker with Tilt for a smooth development experience, with per-service containers, hot reload, and proper log management.

What's actively being worked on:

- **Mobile clients** — Android and iOS apps to act as lightweight mesh participants
- **UI overhaul** — moving from the current PyQt6 desktop UI to a web-based interface accessible from any device
- **Improved local LLMs** — as models like Gemma 3n push the boundary of what runs on consumer hardware, Aurora will be ready
- **OAuth for MCP** — Model Context Protocol already works for tool integration; adding OAuth support will unlock even more integrations

## Try It, Break It, Improve It

Aurora is free, open source, and actively developed. It's not a product, it's a project — and it's built by someone who actually uses it daily and gets frustrated by the same limitations you do.

If you're a developer who wants a private AI assistant you can actually customize, or if you're just curious about what a peer-to-peer AI mesh looks like in practice — check it out on GitHub.

And if the idea of a distributed, private, user-controlled AI ecosystem resonates with you, I'd love to hear your thoughts. What would you build with a mesh of AI services that you fully control?

---

*Aurora is open source and available on GitHub. Star the repo if this vision resonates with you.*

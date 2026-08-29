# Aurora Generic API + WebRTC Module Plan

Status: v0.6 (client-mode, decentralized signaling, auth/ACL, complete snippets)
Owner: Core Platform
Compatibility: Python 3.9–3.11 (not 3.12+)

Goals
- Expose Aurora methods/modules over:
  - HTTP (FastAPI)
  - WebRTC RPC (aiortc DataChannels) with optional media (e.g., TTS)
- Aurora acts as a WebRTC client (not a signaling server):
  - Use decentralized “serverless” signaling (Trystero-like strategies)
  - Rely on STUN/TURN only for ICE (STUN/TURN are not signaling)
- Support rooms, peer discovery, targeted responses, broadcast, and streaming.
- Provide unified decorators so one definition exposes over HTTP and WebRTC.
- Provide robust cryptography guidance:
  - Password-derived keys with Scrypt + HKDF
  - Optional app-layer E2EE for DataChannel payloads
  - Encrypted signaling payloads (SDP/ICE)
- Provide authentication middleware and fine-grained access control:
  - HTTP: token-based (HMAC-signed) with roles/permissions
  - WebRTC: peer-name-based identity + token verification and ACL
- Keep configuration ergonomic: expose only useful options with sensible defaults.
- Integrate with local/process bus via a shared accessor and priority-aware scheduling.

Key Technologies
- FastAPI (HTTP API, streaming responses, lifecycle events)
- aiortc (WebRTC: RTCPeerConnection, DataChannels, MediaStreamTrack)
- Decentralized signaling adapters (Nostr, MQTT, IPFS PubSub, or custom)
- STUN/TURN servers for ICE
- MessageBus interface (publish/request/subscribe with origin/priority)

Dependencies (project-level)
- Python packages (runtime):
  - fastapi>=0.115
  - uvicorn[standard]>=0.30
  - aiortc>=1.9
  - av>=12.0
  - pydantic>=2.10
  - cryptography>=43.0
  - paho-mqtt>=2.1.0      # signaling (MQTT example)
  - nostr>=0.0.2          # optional (Nostr signaling)
  - aioipfs>=0.7.1        # optional (IPFS signaling)

Configuration (minimal set)
- api.enabled: true
- api.host: 0.0.0.0
- api.port: 8000
- api.cors_origins: ["*"]
- api.token_secret: string
- webrtc.enabled: true
- webrtc.strategy: "mqtt" | "nostr" | "ipfs"
- webrtc.app_id: string
- webrtc.room: string
- webrtc.password: string
- webrtc.encrypt_signaling: true
- webrtc.enable_app_layer_e2ee: false
- webrtc.stun_servers: ["stun:stun.l.google.com:19302"]
- webrtc.turn_servers: []
- signaling.mqtt.brokers: ["wss://broker.emqx.io:8084/mqtt", "wss://test.mosquitto.org:8081/mqtt"]
- messaging.priorities: {interactive: 10, system: 50, external: 80}

Security Overview
- HTTP: HMAC-signed bearer token (“AuroraToken”).
- WebRTC: room password derives signaling key (K_sig). Optional data-channel E2EE (K_data).
- ACL: methods declare required permissions; enforced in both HTTP and WebRTC.
- Bus calls from connectivity MUST use origin="external" and priority=messaging.priorities.external.

MessageBus accessor (self-contained)
```python
# app/messaging/bus_runtime.py
from typing import Optional
class MessageBus: ...  # Protocol defined elsewhere in runtime
_bus: Optional[MessageBus] = None

def set_bus(bus: MessageBus) -> None:
    global _bus
    _bus = bus

def get_bus() -> MessageBus:
    if _bus is None:
        raise RuntimeError("MessageBus not initialized")
    return _bus
```

Unified API registry (self-contained excerpt)
```python
# app/api/registry.py
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional
import inspect

@dataclass
class ExposedMethod:
    name: str
    fn: Callable[..., Any]
    streaming: bool = False
    media_type: Optional[str] = None
    transports: str = "both"
    required_perms: set[str] = field(default_factory=set)

_registry: Dict[str, ExposedMethod] = {}

def expose(name: Optional[str] = None, *, streaming: bool = False, media_type: Optional[str] = None, transports: str = "both", perms: Optional[list[str]] = None):
    def wrapper(fn: Callable[..., Any]):
        key = name or fn.__name__
        _registry[key] = ExposedMethod(name=key, fn=fn, streaming=streaming, media_type=media_type, transports=transports, required_perms=set(perms or []))
        return fn
    return wrapper

async def invoke(method: str, params: Dict[str, Any] | None = None) -> Any:
    if method not in _registry:
        raise KeyError(f"method not found: {method}")
    meta = _registry[method]
    fn = meta.fn
    params = params or {}
    if inspect.iscoroutinefunction(fn):
        return await fn(**params)
    return fn(**params)

def get_method_meta(name: str) -> ExposedMethod | None:
    return _registry.get(name)
```

HTTP schemas and dependencies
```python
# app/api/schemas.py
from pydantic import BaseModel
from typing import Any, Dict, Optional
class JSONRPCRequest(BaseModel):
    method: str
    params: Optional[Dict[str, Any]] = None
    id: Optional[str] = None
class JSONRPCResponse(BaseModel):
    result: Any | None = None
    error: dict | None = None
    id: Optional[str] = None
```
```python
# app/api/config.py
from pydantic import BaseModel
from typing import List, Optional
class APISettings(BaseModel):
    enabled: bool = True
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: List[str] = ["*"]
    docs: bool = True
    token_secret: str = "change-me"
class WebRTCSettings(BaseModel):
    enabled: bool = True
    strategy: str = "nostr"
    app_id: str = "aurora"
    room: str = "default"
    password: str = ""
    encrypt_signaling: bool = True
    enable_app_layer_e2ee: bool = False
    stun_servers: List[str] = ["stun:stun.l.google.com:19302"]
    turn_servers: List[str] = []
    turn_username: Optional[str] = None
    turn_password: Optional[str] = None
class MQTTSettings(BaseModel):
    brokers: List[str] = ["wss://broker.emqx.io:8084/mqtt", "wss://test.mosquitto.org:8081/mqtt"]
    username: Optional[str] = None
    password: Optional[str] = None
    topic_root: str = "aurora"
class Settings(BaseModel):
    api: APISettings = APISettings()
    webrtc: WebRTCSettings = WebRTCSettings()
    signaling_mqtt: MQTTSettings = MQTTSettings()
```
```python
# app/api/dependencies.py
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from typing import Any, Dict
from .config import Settings
from .utils.crypto import verify_token, TokenError
_settings = Settings()
security = HTTPBearer(auto_error=False)

def get_settings() -> Settings:
    return _settings

def require_auth(creds: HTTPAuthorizationCredentials = Depends(security), settings: Settings = Depends(get_settings)) -> Dict[str, Any]:
    if creds is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing token")
    token = creds.credentials
    try:
        payload = verify_token(settings.api.token_secret, token)
        return payload
    except TokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
```

HTTP RPC route
```python
# app/api/http_rpc.py
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse, JSONResponse
from typing import Any, AsyncGenerator, Dict
from .schemas import JSONRPCRequest, JSONRPCResponse
from .registry import invoke, get_method_meta
from .dependencies import require_auth

router = APIRouter()

@router.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}

@router.post("/rpc")
async def rpc(req: JSONRPCRequest, auth=Depends(require_auth)):
    meta = get_method_meta(req.method)
    if not meta:
        raise HTTPException(status_code=404, detail="method not found")
    perms_needed = meta.required_perms
    user_perms = set(auth.get("perms", [])) | set(auth.get("roles", []))
    if not perms_needed.issubset(user_perms):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
    result = await invoke(req.method, req.params or {})
    if meta.streaming and hasattr(result, "__aiter__"):
        async def stream(gen: AsyncGenerator[bytes, None]):
            async for chunk in gen:
                yield chunk
        return StreamingResponse(stream(result), media_type=meta.media_type or "application/octet-stream")
    return JSONResponse(content=JSONRPCResponse(result=result, id=req.id).model_dump())
```

Crypto helpers (signaling + tokens)
```python
# app/api/utils/crypto.py
import base64, json, os, hmac, hashlib, time
from dataclasses import dataclass
from typing import Any, Dict
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
B64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
B64D = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
@dataclass
class RoomKeys:
    k0: bytes
    k_sig: bytes
    k_data: bytes

def _hash_room(app_id: str, room: str) -> bytes:
    return hashlib.sha256((app_id + "|" + room).encode()).digest()

def derive_room_keys(password: str, app_id: str, room: str, *, data_info: bytes = b"aurora/webrtc/data") -> RoomKeys:
    salt = _hash_room(app_id, room)
    kdf = Scrypt(salt=salt, length=32, n=2**14, r=8, p=1)
    k0 = kdf.derive(password.encode())
    k_sig = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"aurora/webrtc/signaling").derive(k0)
    k_data = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=data_info).derive(k0)
    return RoomKeys(k0=k0, k_sig=k_sig, k_data=k_data)

def aead_seal(key: bytes, obj: Dict[str, Any]) -> bytes:
    nonce = os.urandom(12)
    pt = json.dumps(obj, separators=(",", ":")).encode()
    ct = AESGCM(key).encrypt(nonce, pt, None)
    return nonce + ct

def aead_open(key: bytes, payload: bytes) -> Dict[str, Any]:
    nonce, ct = payload[:12], payload[12:]
    pt = AESGCM(key).decrypt(nonce, ct, None)
    return json.loads(pt.decode())

class TokenError(Exception):
    pass

def issue_token(secret: str, *, sub: str, roles: list[str] | None = None, perms: list[str] | None = None, ttl_seconds: int = 3600, peer_name: str | None = None) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": sub, "roles": roles or [], "perms": perms or [], "exp": int(time.time()) + ttl_seconds}
    if peer_name:
        payload["peer_name"] = peer_name
    h = B64(json.dumps(header, separators=(",", ":")).encode())
    p = B64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), msg=f"{h}.{p}".encode(), digestmod=hashlib.sha256).digest()
    s = B64(sig)
    return f"{h}.{p}.{s}"

def verify_token(secret: str, token: str) -> Dict[str, Any]:
    try:
        h, p, s = token.split(".")
        sig = hmac.new(secret.encode(), msg=f"{h}.{p}".encode(), digestmod=hashlib.sha256).digest()
        if not hmac.compare_digest(sig, B64D(s)):
            raise TokenError("bad signature")
        payload = json.loads(B64D(p))
        if int(payload.get("exp", 0)) < int(time.time()):
            raise TokenError("expired")
        return payload
    except Exception as e:
        raise TokenError(str(e))
```

WebRTC signaling base + MQTT adapter
```python
# app/api/webrtc/signaling/base.py
from typing import Awaitable, Callable, Protocol
OnMessage = Callable[[bytes], Awaitable[None]]
class SignalingAdapter(Protocol):
    async def connect(self) -> None: ...
    async def join_room(self, app_id: str, room: str, peer_id: str) -> None: ...
    async def send(self, channel: str, payload: bytes, to_peer: str | None = None) -> None: ...
    def on_message(self, channel: str, handler: OnMessage) -> None: ...
    async def leave(self) -> None: ...
    async def close(self) -> None: ...
```
```python
# app/api/webrtc/signaling/mqtt_client.py
import asyncio, json
from typing import Awaitable, Callable, Dict, Optional
import paho.mqtt.client as mqtt
OnMessage = Callable[[bytes], Awaitable[None]]
class MQTTSignaling:
    def __init__(self, brokers: list[str], topic_root: str = "aurora", username: str | None = None, password: str | None = None):
        self._brokers = brokers
        self._topic_root = topic_root
        self._username = username
        self._password = password
        self._client = mqtt.Client(protocol=mqtt.MQTTv5)
        self._loop = asyncio.get_event_loop()
        self._handlers: Dict[str, OnMessage] = {}
        self._app_id = self._room = self._peer_id = ""
        self._connected = asyncio.Event()
        self._subscribed = False

    def _topic(self, channel: str, to_peer: Optional[str] = None) -> str:
        base = f"{self._topic_root}/{self._app_id}/{self._room}/{channel}"
        return f"{base}/{to_peer}" if to_peer else base

    async def connect(self) -> None:
        if self._username:
            self._client.username_pw_set(self._username, self._password or "")
        self._client.on_connect = lambda c, u, f, rc, props=None: self._connected.set()
        self._client.on_message = self._on_message
        # Pick first working broker
        for url in self._brokers:
            try:
                if url.startswith("wss://") or url.startswith("ws://"):
                    self._client.connect_uri(url)
                else:
                    host = url.replace("mqtt://", "").split(":")[0]
                    port = int(url.split(":")[-1]) if ":" in url else 1883
                    self._client.connect(host, port, keepalive=30)
                self._client.loop_start()
                await asyncio.wait_for(self._connected.wait(), timeout=10)
                return
            except Exception:
                try: self._client.loop_stop()
                except Exception: pass
                continue
        raise RuntimeError("MQTTSignaling: failed to connect brokers")

    async def join_room(self, app_id: str, room: str, peer_id: str) -> None:
        self._app_id, self._room, self._peer_id = app_id, room, peer_id
        topics = [
            (self._topic("presence"), 0),
            (self._topic("offer", to_peer=peer_id), 0),
            (self._topic("answer", to_peer=peer_id), 0),
            (self._topic("candidate", to_peer=peer_id), 0),
            (self._topic("broadcast"), 0),
        ]
        for t, qos in topics:
            self._client.subscribe(t, qos=qos)
        self._subscribed = True
        self._client.publish(self._topic("presence"), json.dumps({"type": "presence", "app_id": app_id, "room": room, "peer_id": peer_id}).encode(), qos=0, retain=False)

    def on_message(self, channel: str, handler: OnMessage) -> None:
        self._handlers[channel] = handler

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        channel = topic.split("/")[-1]
        handler = self._handlers.get(channel)
        if handler:
            asyncio.run_coroutine_threadsafe(handler(msg.payload), self._loop)

    async def send(self, channel: str, payload: bytes, to_peer: str | None = None) -> None:
        self._client.publish(self._topic(channel, to_peer), payload, qos=0, retain=False)

    async def leave(self) -> None:
        if self._subscribed:
            for ch in ("presence", "offer", "answer", "candidate", "broadcast"):
                self._client.unsubscribe(self._topic(ch, to_peer=self._peer_id if ch in ("offer", "answer", "candidate") else None))
            self._subscribed = False

    async def close(self) -> None:
        try: self._client.loop_stop()
        except Exception: pass
        try: self._client.disconnect()
        except Exception: pass
```

WebRTC RTC client and RPC handler
```python
# app/api/webrtc/rpc.py
import json
from typing import Any, Dict, Callable
from ..registry import invoke, get_method_meta
class RPCHandler:
    def __init__(self, send_fn: Callable[[str], None], acl_provider: Callable[[], Dict[str, Any]]):
        self._send = send_fn
        self._acl_provider = acl_provider
    async def on_message(self, text: str):
        msg = json.loads(text)
        t = msg.get("type")
        if t == "call":
            method = msg.get("method"); params = msg.get("params") or {}; req_id = msg.get("id")
            meta = get_method_meta(method)
            if not meta:
                self._send(json.dumps({"type": "error", "id": req_id, "error": {"code": 404, "message": "not found"}})); return
            perms_needed = meta.required_perms
            identity = self._acl_provider()
            user_perms = set(identity.get("perms", [])) | set(identity.get("roles", []))
            if not perms_needed.issubset(user_perms):
                self._send(json.dumps({"type": "error", "id": req_id, "error": {"code": 403, "message": "forbidden"}})); return
            try:
                result = await invoke(method, params)
                if meta.streaming and hasattr(result, "__aiter__"):
                    async for chunk in result:
                        self._send(json.dumps({"type": "chunk", "id": req_id, "data": chunk if isinstance(chunk, str) else chunk.decode(errors="ignore")}))
                    self._send(json.dumps({"type": "eof", "id": req_id}))
                else:
                    self._send(json.dumps({"type": "result", "id": req_id, "result": result}))
            except Exception as e:
                self._send(json.dumps({"type": "error", "id": req_id, "error": {"code": 500, "message": str(e)}}))
```
```python
# app/api/webrtc/rtc_client.py
import asyncio, json, uuid
from typing import Dict, Optional
from aiortc import RTCPeerConnection, RTCSessionDescription
from .signaling.base import SignalingAdapter
from .signaling.mqtt_client import MQTTSignaling
from ..utils.crypto import derive_room_keys, aead_seal, aead_open
from ..config import Settings
from .rpc import RPCHandler
class RTCClient:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._peer_id = str(uuid.uuid4())
        self._keys = derive_room_keys(settings.webrtc.password, settings.webrtc.app_id, settings.webrtc.room)
        self._adapter: Optional[SignalingAdapter] = None
        self._pcs: Dict[str, RTCPeerConnection] = {}
        self._peer_acl: Dict[str, Dict] = {}
    async def start(self):
        s = self._settings
        if s.webrtc.strategy == "mqtt":
            self._adapter = MQTTSignaling(brokers=s.signaling_mqtt.brokers, topic_root=s.signaling_mqtt.topic_root, username=s.signaling_mqtt.username, password=s.signaling_mqtt.password)
        else:
            raise RuntimeError("Only MQTT example adapter is included")
        await self._adapter.connect()
        self._adapter.on_message("presence", self._on_presence)
        self._adapter.on_message("offer", self._on_offer)
        self._adapter.on_message("answer", self._on_answer)
        self._adapter.on_message("candidate", self._on_candidate)
        self._adapter.on_message("broadcast", self._on_broadcast)
        await self._adapter.join_room(s.webrtc.app_id, s.webrtc.room, self._peer_id)
    async def close(self):
        for pc in list(self._pcs.values()):
            await pc.close()
        if self._adapter:
            await self._adapter.leave(); await self._adapter.close()
    async def _on_presence(self, payload: bytes):
        pass
    def _ice_servers(self):
        iceServers = [{"urls": self._settings.webrtc.stun_servers}]
        if self._settings.webrtc.turn_servers:
            iceServers.append({"urls": self._settings.webrtc.turn_servers, "username": self._settings.webrtc.turn_username, "credential": self._settings.webrtc.turn_password})
        return {"iceServers": iceServers}
    async def _ensure_pc(self, peer: str) -> RTCPeerConnection:
        if peer in self._pcs: return self._pcs[peer]
        pc = RTCPeerConnection(configuration=self._ice_servers())
        channel = pc.createDataChannel("aurora-rpc")
        self._peer_acl.setdefault(peer, {"peer_name": None, "roles": [], "perms": []})
        def send_fn(text: str):
            if channel.readyState == "open": channel.send(text)
        handler = RPCHandler(send_fn, lambda: self._peer_acl[peer])
        @channel.on("open");
        def on_open():
            pass
        @channel.on("message")
        def on_message(message):
            if isinstance(message, bytes):
                try:
                    if self._settings.webrtc.enable_app_layer_e2ee:
                        obj = aead_open(self._keys.k_data, message); text = json.dumps(obj)
                    else:
                        text = message.decode()
                except Exception:
                    return
            else:
                text = message
            try:
                obj = json.loads(text)
                if obj.get("type") == "auth":
                    self._peer_acl[peer] = {"peer_name": obj.get("peer_name"), "roles": obj.get("roles", []), "perms": obj.get("perms", [])}
                else:
                    asyncio.create_task(handler.on_message(text))
            except Exception:
                return
        @pc.on("icecandidate")
        async def on_icecandidate(event):
            candidate = event.candidate
            if candidate is None: return
            msg = {"type": "candidate", "app_id": self._settings.webrtc.app_id, "room": self._settings.webrtc.room, "from": self._peer_id, "to": peer, "candidate": candidate.to_sdp()}
            sealed = aead_seal(self._keys.k_sig, msg)
            await self._adapter.send("candidate", sealed, to_peer=peer)
        self._pcs[peer] = pc
        return pc
    async def connect_to(self, peer: str):
        pc = await self._ensure_pc(peer)
        offer = await pc.createOffer(); await pc.setLocalDescription(offer)
        msg = {"type": "offer", "app_id": self._settings.webrtc.app_id, "room": self._settings.webrtc.room, "from": self._peer_id, "to": peer, "sdp": pc.localDescription.sdp}
        sealed = aead_seal(self._keys.k_sig, msg)
        await self._adapter.send("offer", sealed, to_peer=peer)
    async def _on_offer(self, payload: bytes):
        msg = aead_open(self._keys.k_sig, payload); peer = msg.get("from")
        pc = await self._ensure_pc(peer)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="offer"))
        answer = await pc.createAnswer(); await pc.setLocalDescription(answer)
        out = {"type": "answer", "app_id": self._settings.webrtc.app_id, "room": self._settings.webrtc.room, "from": self._peer_id, "to": peer, "sdp": pc.localDescription.sdp}
        sealed = aead_seal(self._keys.k_sig, out); await self._adapter.send("answer", sealed, to_peer=peer)
    async def _on_answer(self, payload: bytes):
        msg = aead_open(self._keys.k_sig, payload); peer = msg.get("from")
        pc = await self._ensure_pc(peer); await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="answer"))
    async def _on_candidate(self, payload: bytes):
        msg = aead_open(self._keys.k_sig, payload); peer = msg.get("from"); cand = msg.get("candidate")
        from aiortc.sdp import candidate_from_sdp
        candidate = candidate_from_sdp(cand); pc = await self._ensure_pc(peer)
        await pc.addIceCandidate(candidate)
    async def _on_broadcast(self, payload: bytes):
        pass
```

Bus bridge helpers (connectivity -> bus)
```python
# app/api/bus_bridge.py
from typing import Any, Dict
from pydantic import BaseModel
from app.api.registry import expose
from app.messaging.bus_runtime import get_bus
ALLOWED_TOPICS = {
    "TTS.Request": "tts:request",
    "TTS.Stop": "tts:control",
    "TTS.Pause": "tts:control",
    "TTS.Resume": "tts:control",
    "DB.GetRecentMessages": "db:read",
    "Sched.Schedule": "sched:write",
    "Sched.Cancel": "sched:write",
}
@expose(name="bus.publish", perms=["bus:publish"])  # constrained by topic map
async def bus_publish(topic: str, payload: Dict[str, Any], priority: int | None = None) -> dict:
    if topic not in ALLOWED_TOPICS: raise ValueError("topic not allowed")
    bus = get_bus()
    class _AdHoc(BaseModel): data: Dict[str, Any]
    await bus.publish(topic, _AdHoc(data=payload), event=False, origin="external", priority=priority or 80)
    return {"ok": True}
@expose(name="bus.request", perms=["bus:request"])  # constrained by topic map
async def bus_request(topic: str, payload: Dict[str, Any], timeout: float = 5.0, priority: int | None = None) -> dict:
    if topic not in ALLOWED_TOPICS: raise ValueError("topic not allowed")
    bus = get_bus()
    class _AdHoc(BaseModel): data: Dict[str, Any]
    res = await bus.request(topic, _AdHoc(data=payload), timeout=timeout, origin="external", priority=priority or 80)
    return {"ok": res.ok, "data": res.data, "error": res.error}
```

Step-by-step Implementation Checklist (self-contained)
- [ ] Verify Python version is 3.9–3.11; install system deps for building aiortc/av as needed.
- [ ] Add runtime deps to requirements-runtime.txt: fastapi, uvicorn[standard], aiortc, av, pydantic, cryptography, paho-mqtt.
- [ ] Create API config and settings: app/api/config.py with APISettings/WebRTCSettings/MQTTSettings/Settings.
- [ ] Create crypto helpers: app/api/utils/crypto.py (derive_room_keys, aead_seal/open, tokens).
- [ ] Implement API registry: app/api/registry.py (expose(), invoke(), metadata access).
- [ ] Implement HTTP schemas and RPC route: app/api/schemas.py, app/api/http_rpc.py with auth/ACL enforcement.
- [ ] Implement MQTT signaling adapter: app/api/webrtc/signaling/mqtt_client.py and base protocol.
- [ ] Implement RTC client: app/api/webrtc/rtc_client.py and RPC handler: app/api/webrtc/rpc.py.
- [ ] Implement bus bridge methods: app/api/bus_bridge.py mapping to MessageBus with origin="external" and external priority.
- [ ] Create FastAPI app factory: app/api/server.py; include router and start RTCClient on startup when enabled.
- [ ] Supervisor integration: ensure a MessageBus instance is initialized before starting API/WebRTC; fail-fast otherwise.
- [ ] Tests: unit test crypto, tokens, registry; integration test MQTT signaling loopback; WebRTC two-peer RPC; bus bridge priority preemption vs internal calls.
- [ ] Docs: document config keys, signaling backend choices, security, tokens, and how to run.

Validation Checklist
- [ ] /health returns ok; /rpc enforces ACL; invoke registered methods.
- [ ] DataChannel RPC call succeeds end-to-end between two local peers.
- [ ] External bus calls are tagged origin=external and use external priority; no command drops.

Acceptance Criteria
- HTTP and WebRTC layers expose registered methods with ACL and optional streaming.
- Bus bridge correctly forwards to MessageBus with priority and reliability.
- Signaling encryption works (offer/answer/candidate sealed/unsealed) and optional app-layer E2EE functions.

End of v0.6

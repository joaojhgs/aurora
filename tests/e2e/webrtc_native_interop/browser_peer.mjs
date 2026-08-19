// Browser answerer for the native WebRTC interop lane.
//
// Drives a real browser RTCPeerConnection against the Rust peer and echoes every
// data-channel message verbatim. This is the pairing thin-to-thin needs once the
// mobile transport is native, and the one that is not covered anywhere else.
//
// Env:
//   AURORA_INTEROP_BROWSER  chromium | firefox | webkit   (default chromium)
//   AURORA_INTEROP_MDNS     off disables Chromium's mDNS host-candidate
//                           obfuscation, isolating stack interop from local
//                           multicast DNS resolution.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
// Resolve through @playwright/test, which is the workspace dependency.
const playwright = require('@playwright/test');

const binary = process.argv[2];
const browserName = process.env.AURORA_INTEROP_BROWSER ?? 'chromium';
const mdns = process.env.AURORA_INTEROP_MDNS !== 'off';

const launchArgs = [];
if (browserName === 'chromium' && !mdns) {
  launchArgs.push('--disable-features=WebRtcHideLocalIpsWithMdns');
}

const browser = await playwright[browserName].launch(
  launchArgs.length > 0 ? { args: launchArgs } : {},
);
const page = await browser.newPage();
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });

let resolveResult;
const resultPromise = new Promise((resolve) => {
  resolveResult = resolve;
});

for await (const line of rl) {
  if (line.startsWith('OFFER ')) {
    const offer = JSON.parse(line.slice('OFFER '.length));
    const answer = await page.evaluate(async (offer) => {
      const pc = new RTCPeerConnection();
      const gatheredCandidates = [];
      const gathered = new Promise((resolve) => {
        pc.onicecandidate = (event) => {
          if (event.candidate) gatheredCandidates.push(event.candidate.candidate);
          else resolve();
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') resolve();
        };
        setTimeout(resolve, 15_000);
      });
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        channel.onmessage = (message) => channel.send(message.data);
      };
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered;
      return { sdp: pc.localDescription.sdp, candidates: gatheredCandidates };
    }, offer);

    let sdp = answer.sdp;
    if (!/^a=candidate:/m.test(sdp) && answer.candidates.length > 0) {
      // Non-trickle assembly: some engines leave trickled candidates out of
      // localDescription, and the Rust peer takes a single complete answer.
      const out = [];
      let inserted = false;
      for (const sdpLine of sdp.split('\r\n')) {
        out.push(sdpLine);
        if (!inserted && sdpLine.startsWith('a=fingerprint:')) {
          for (const candidate of answer.candidates) out.push(`a=${candidate}`);
          out.push('a=end-of-candidates');
          inserted = true;
        }
      }
      sdp = out.join('\r\n');
    }
    child.stdin.write(`ANSWER ${JSON.stringify({ type: 'answer', sdp })}\n`);
  } else if (line.startsWith('RESULT ')) {
    resolveResult(JSON.parse(line.slice('RESULT '.length)));
  }
}

const result = await Promise.race([
  resultPromise,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('interop lane timed out')), 90_000),
  ),
]);
await browser.close();

const lane = `${browserName}${mdns ? '-mdns' : '-direct'}`;
const pass =
  result.orderedExactEcho === true &&
  result.largePayloadOk === true &&
  result.echoed === result.expected;
console.log(JSON.stringify({ lane, ...result, pass }));
process.exit(pass ? 0 : 1);

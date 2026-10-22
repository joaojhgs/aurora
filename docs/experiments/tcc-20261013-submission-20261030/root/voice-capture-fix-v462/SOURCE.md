# V462 focused voice capture source findings

## Source-grounded findings

The focused browser PTT flow exposes `listening` before the microphone
pipeline has completed startup. In
`packages/aurora-ui/src/use-assistant-browser-capture.ts`,
`startBrowserVoiceCapture` sets capture status to `listening` at line 248,
then awaits runtime creation and `runtime.start()` at lines 251–252. The
stream-state text at that point itself says microphone access is being
requested. The later `session_started` runtime event also sets `listening`,
but it is emitted only after runtime startup completes. Thus the UI status is
not a source-readiness signal; a driver that begins its fixed audio schedule
when it first sees `listening` can start before `getUserMedia`, AudioWorklet
module initialization, audio-context resume, worker startup, and PCM-source
activation have finished.

`packages/aurora-voice-web/src/runtime.ts` confirms the later readiness
boundary: `start()` initializes the worker, sends and validates the worker
start acknowledgment, awaits `pcmSource.start(...)`, checks the session is
still current, and only then emits `session_started` (lines 124–169).
`AuroraBrowserAudioWorkletSource.start` awaits `getUserMedia`, worklet module
loading, context resume, and source/worklet connection before assigning the
active capture (lines 123–183). These are materially later than the initial
UI status update.

The normal stop path also has a source-supported tail-loss window.
`AuroraBrowserAudioWorkletSource.stop` first awaits the currently tracked
message chain, sets `active.stopping = true`, sends the worklet `stop` request,
then awaits the message chain again and cleans up before calling
`assembler.flush()` (lines 196–213). Meanwhile
`handleWorkletMessage` discards every incoming audio message when
`active.stopping` is true (line 242). The worklet processor posts audio blocks
and then acknowledges the stop command over its port; the assembler's later
`flush()` pads and sends only samples it already received (source lines
400–417 and processor lines 31–58, 61–79). Consequently, audio messages
already posted by the processor but delivered after the stopping flag is set
can be dropped; the subsequent assembler flush cannot recover those blocks.
This is an implementation-level possibility for losing tail PCM, not proof
that the particular observed fixture run lost a block.

## Runtime interpretation and limit

For the supplied V462 run, the fixture began 0.657 seconds after observing
`listening`, and its best waveform alignment was offset by 0.088 seconds.
Those measurements are consistent with startup/status skew or a truncated
tail, but they do not identify which occurred in that run. No retained runtime
fact establishes that capture had not become ready before fixture playback,
or that an in-flight final worklet message was dropped. The current source
does establish that both conditions are possible, so this should be handled
as a real main-flow fidelity gap rather than described as a proven cause of
the particular recognition result.

## Smallest source correction for Root review

For capture readiness, move the user-visible `listening` transition to the
existing post-`runtime.start()` success point (the runtime's
`session_started` event already represents that boundary), while retaining a
non-listening startup state during permission/activation. For stop fidelity,
continue accepting audio messages until the processor's stop acknowledgment
has been handled, then set `active.stopping`, drain the resulting message
chain, release capture resources, and flush the assembler. Preserve the
existing stop timeout and fail-closed cleanup behavior. These are
recommendations for Root's implementation/review; this report changes no
product source and makes no runtime-pass claim.

## Source identity

- `packages/aurora-ui/src/use-assistant-browser-capture.ts` SHA256:
  `f6d1d6e2f1d6d164e446271917bc8534f0e283be58a40ddabf845e4a66e069cd`
- `packages/aurora-voice-web/src/runtime.ts` SHA256:
  `c8d9da336f4616f30fc45d20f83ec71a13f8996e98c7e4db1669ea91d3866286`
- `packages/aurora-voice-web/src/audio-worklet-source.ts` SHA256:
  `cd249ff9fc569da31c2cd2b1f556a8f1f779fc5b2cf36a786ace3632d686ed6c`
- `packages/aurora-voice-web/src/audio-worklet-processor.ts` SHA256:
  `ed33c99845d9873e9b9c053c991383db92c5c9ab99b9815a9b1fcf196a473a9a`

No tests, browser runs, models, or source changes were performed for this
slice.

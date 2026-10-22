"""Private pilot call-binding observer; delegates each real call exactly once."""
from __future__ import annotations
import functools, hashlib, inspect, json, os, pathlib, threading, time, sys
_lock = threading.Lock()

def write(row):
    row.update(pid=os.getpid(), monotonicNs=time.monotonic_ns())
    telemetry = sys.modules.get('aurora_voice_telemetry_v430')
    case_id = getattr(telemetry, '_active_case_id', lambda: None)()
    row['harness_case_id'] = case_id
    row['harness_stage_id'] = (
        f'{case_id}:tts' if case_id and row.get('event', '').startswith('piper_cli_call_')
        else (f'{case_id}:provider_setup' if case_id else None)
    )
    path = pathlib.Path(os.environ['AURORA_VOICE_STAGE_OUTPUT']).with_name('actual-provider-bindings.jsonl')
    with _lock, path.open('a') as output:
        output.write(json.dumps(row, sort_keys=True) + '\n')

def identity(value):
    cls = type(value)
    return {'class': cls.__module__+'.'+cls.__qualname__, 'objectId': id(value)}

def install():
    import app.services.stt_transcription.service as stt
    import app.services.tts.providers.piper as piper
    import app.services.orchestrator.agents.chatbot as chatbot
    original_whisper = stt._create_whisper_model
    @functools.wraps(original_whisper)
    def whisper(*args, **kwargs):
        declared = {'model': str(args[0]) if args else kwargs.get('model_size_or_path'),
                    **{key: kwargs.get(key) for key in ('device','device_index','compute_type')}}
        write({'event':'stt_constructor_start','actualArguments':declared})
        result = original_whisper(*args, **kwargs)
        engine = getattr(result, 'model', None)
        write({'event':'stt_constructor_return','actualArguments':declared,'returned':identity(result),
               'engine':identity(engine), 'actualDevice':getattr(engine,'device',None),
               'actualComputeType':getattr(engine,'compute_type',None)})
        return result
    stt._create_whisper_model = whisper
    original_piper = piper.synthesize_piper_cli
    @functools.wraps(original_piper)
    def synthesize(*args, **kwargs):
        voice = kwargs.get('voice')
        binding = {'piperExecutable':kwargs.get('piper_path'), 'useCuda':kwargs.get('use_cuda'),
                   'voice': {key:getattr(voice,key,None) for key in ('model_file','config_file','expected_sample_rate','voice_id')}}
        write({'event':'piper_cli_call_start','actualArguments':binding})
        result = original_piper(*args, **kwargs)
        write({'event':'piper_cli_call_return','audioBytes':len(result[0]),'sampleRate':result[1]})
        return result
    piper.synthesize_piper_cli = synthesize
    original_construct = chatbot._construct_llama_model
    @functools.wraps(original_construct)
    async def construct(constructor, options):
        binding = {key:options.get(key) for key in ('model_path','n_gpu_layers','n_ctx','n_batch','n_threads','temperature','max_tokens','seed','top_p','top_k','repeat_penalty','min_p','chat_format','verbose')}
        write({'event':'llm_constructor_start','constructor':constructor.__module__+'.'+constructor.__qualname__,'actualArguments':binding})
        result = await original_construct(constructor, options)
        write({'event':'llm_constructor_return','returned':identity(result),'actualArguments':binding,'effectiveWrapperSettings':{key:getattr(result,key,None) for key in ('seed','n_threads','n_ctx','n_batch','n_gpu_layers','verbose')},'actualClient':identity(getattr(result,'client',None))})
        return result
    chatbot._construct_llama_model = construct

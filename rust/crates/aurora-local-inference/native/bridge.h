#ifndef AURORA_LOCAL_INFERENCE_BRIDGE_H
#define AURORA_LOCAL_INFERENCE_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct aurora_llama_engine aurora_llama_engine;
typedef struct aurora_llama_cancel aurora_llama_cancel;

/* All strings are UTF-8. Returned strings belong to the caller and must be
 * released with aurora_llama_free_string. Error text is deliberately generic. */
void aurora_llama_backend_init(void);
int32_t aurora_llama_engine_create(
    const char * model_path,
    uint32_t context_tokens,
    uint32_t threads,
    aurora_llama_engine ** engine_out,
    char ** error_out);
void aurora_llama_engine_destroy(aurora_llama_engine * engine);
int32_t aurora_llama_engine_reset(aurora_llama_engine * engine);

aurora_llama_cancel * aurora_llama_cancel_create(void);
void aurora_llama_cancel_request(aurora_llama_cancel * cancellation);
int32_t aurora_llama_cancel_is_requested(const aurora_llama_cancel * cancellation);
void aurora_llama_cancel_destroy(aurora_llama_cancel * cancellation);

int32_t aurora_llama_complete(
    aurora_llama_engine * engine,
    const char * request_json,
    aurora_llama_cancel * cancellation,
    char ** response_json_out,
    char ** error_out);

void aurora_llama_free_string(char * value);

#ifdef __cplusplus
}
#endif

#endif

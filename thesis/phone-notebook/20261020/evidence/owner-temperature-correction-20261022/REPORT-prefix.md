**Resultado real após correção — 2026-10-22T03:37:44.949539+00:00**

O limite térmico personalizado foi removido e o trabalho prosseguiu: **llama-cpp-python 0.3.19 Vulkan compilado/importado**, comando em 499,14 s; **engine Android ARM64 Sherpa 1.13.5 com patches + ONNX Runtime 1.27.1 compilado**, exit 0 em 361,52 s, pico RSS da árvore 741 MB. [Runtime](RUNTIME-BUILD-RESULT-20261022.json), [engine real](evidence/actual-built-native-engine-20261022T0334/result.json) e [hashes dos binários](evidence/built-runtime-hashes-20261022T0340/result.json).

**A exposição GPU ainda impede aceitar o backend fixado:** o loader registra `No devices found` e `gpuOffloadBuildSupport=false`; ambos os render nodes estão sem acesso neste contexto Personal, e a biblioteca/ICD NVIDIA não estão disponíveis. Os checks dos caminhos existentes foram executados, sem alterações de driver/permissão/segurança. Não foi carregado modelo com fallback CPU. O bloqueio exato foi enviado ao coordenador para Coding/owner (`msg_ce699bffa93a`).

Os 1.959 arquivos e os 833.499.307 bytes dos insumos originais não foram baixados novamente. Os novos downloads foram **dependências nativas de empacotamento fixadas na própria fonte**, com SHA conferido: Sherpa, ORT, fonte llama.cpp Android e componentes Needle2 do APK; não são substitutos dos modelos de comparação. O APK está sendo preparado em cópia derivada isolada, preservando fonte imutável e checkout sujo. Ainda não há aceite de arquivo→STT→LLM→TTS→WAV nativo, HTTP autenticado ou P2P, nem previsão de duração de piloto. O telefone não foi ocupado por turno desta sessão; HTTP principal intacto; nenhum START/900 noturno.

---


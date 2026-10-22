**22/10, 01:25 UTC — arquivos prontos; setup nativo ainda não pronto**

O notebook Personal baixou diretamente dos originais públicos os oito arquivos fixados: **833.499.307 bytes**, todos com tamanho e SHA256 confirmados. Isso inclui Whisper base, Qwen3.5-0.8B Q4_0, Piper/configuração e a fonte oficial do llama-cpp-python 0.3.19. O download terminou às 01:21:25 UTC, sem transferência de modelos pelo worker ou desktop. Outros sete artefatos de build passaram seus hashes; as ferramentas foram instaladas no venv isolado, e os pacotes Vulkan originais foram extraídos apenas no prefixo do projeto. [Recibo real](evidence/read-assets-runtime-20261022T012132/result.json).

**Bloqueio físico atual:** às 01:25:19 UTC, o controlador Personal respondeu normalmente, mas o inventário estava vazio e `get-state` do POCO retornou exit 1, `device not found`. Não há Xiaomi USB exposto nesse contexto; o proxy Orca aprovado também está vazio. O servidor mudou externamente para PID 48127, `/usr/lib/android-sdk/platform-tools/adb`. Não foi observado estado `unauthorized` ou diálogo de aprovação. A ação mínima é restaurar a exposição USB/controlador já autorizada do aparelho. [Comandos e metadados atuais](evidence/current-usb-server-20261022T012515/result.json).

**Bloqueio térmico:** o notebook permanece próximo de 94,25 °C. Compilação e piloto exigem menos de 85 °C. A espera terminou automaticamente às 01:33:02 UTC por esse limite térmico, com status `FAILED_PRESERVED`, sem iniciar compilador ou carregar modelo. O recibo confirmou `ownBuildChildrenActive=false`. Há cerca de 100 GB livres e 18 GB de RAM disponíveis. Não encerrei trabalhos de outros contextos para resfriar a máquina.

**Fonte:** preparei um delta de 3.913.736 bytes, reutilizando 759 blobs/modos idênticos da base Git existente e incluindo 1.200 arquivos diferentes. A montagem valida os 1.959 arquivos do commit `ebde3a8acf6315f920d03593845f17a1fc65a733`, sem escrita Git e sem copiar arquivos sujos do checkout. O receptor fixado e o envio de **43 quadros sequenciais** estão preparados. As janelas antigas expiraram sem lançamento ou cópia; uma nova janela UTC de 120 segundos foi solicitada ao Root (`msg_6b1ac7496156`). [Manifesto do delta](source-delta-v28/DELTA-MANIFEST.json). O SHA remoto segue desconhecido.

**Aceitação pendente:** app com fonte/build conhecidos, runtime Vulkan compilado, telefone acessível e fluxo nativo real de arquivo → STT → LLM → TTS → WAV válido em HTTP autenticado e P2P MQTT/ICE do mesmo par. Ainda há zero chamadas de modelo, zero pilotos e zero casos de coleta; não há previsão de duração derivada de piloto. Os checks antigos de ferramentas não contam como aceitação. A coleta integral exige o posterior sinal de dormir e um horário final explícito. O aparelho não foi ocupado por app/turno desta sessão e o teste principal permaneceu intacto.

As observações e falhas anteriores seguem preservadas abaixo. Os dados atuais estão em [ASSET-READINESS-20261022.json](ASSET-READINESS-20261022.json) e [SETUP-STATUS-20261022.json](SETUP-STATUS-20261022.json).

---


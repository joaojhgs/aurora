**Current bounded check — encerramento da janela, 22/10/2026 12:06 UTC**

**Setup distribuído ainda NÃO pronto. Instalação concluída; LLM e pipeline local no telefone já funcionaram.** A janela original terminou às **11:57:25.269652 UTC**. Nenhuma coleta900 começou: **0 casos medidos**, sem p50/p90/p95 ou previsão distribuída inventados. Os dois serviços próprios foram encerrados com verificação do PID/start-time. O telefone voltou à tela inicial às11:59:46 UTC por ação HOME normal; a tentativa anterior de force-stop falhou e seu resultado foi preservado. A devolução à tela inicial não comprova morte do processo Android. Após o prazo houve somente cleanup e custódia de arquivos fechados.

| Verificação | Resultado comprovado |
|---|---|
| Atualização Android | Uma substituição normal `adb install -r` terminou `Success` **11:52:55 UTC**, sem apagar dados. APK instalado749.091.842bytes, SHA256`ac043bd2f36071af8bc82c68de382d4e5cde495a612738d1ec78902d84fe8f72`; pacote`dev.aurora.desktop.phonenotebook`1.0.0/code100/ARM64, mesma assinatura`57bee2b4…`.13 observações sem instalador em primeiro plano; nenhum aceite automatizado. Esta atualização passou; confirmações futuras não são garantidas. |
| LLM local no POCO | **Implementado, compilado, exposto e validado de verdade**: Qwen nativo respondeu **Paris**; cancelamento e destruição da sessão confirmados. Pipeline anterior arquivo→STT ONNX→Qwen JNI→Piper→WAV válido concluiu em279,0s às07:19:54. Não foi repetido nem agrupado com fontes posteriores. |
| Pareamento e consentimento | Fluxo seguro normal concluído às10:52:14, mesmo Notebook, grant não-admin limitado aos recursos de voz; zero serviços do telefone compartilhados. Conexão nativa autorizada e par ICE selecionado observados em tentativas anteriores. |
| Piloto final P2P v341 | Às11:53:58, falhou **`android_file_audio_route_unavailable`** na entrada nativa em3,6ms, antes de enviar áudio/modelos. Sem WAV remoto. O bootstrap/sessão do último APK não estava disponível no ponto observado; causa final ainda não estabelecida. |
| Correções remotas | v7 corrigiu papel SDP/negociação, v8 adicionou metadados de vínculo de voz preservando autorização do receptor, v8a anuncia lease na sessão consumer sem expor serviços do telefone. Testes focados/build passaram e o APK v8a foi instalado; seu efeito na chamada real ainda não foi validado porque o último caso parou antes. Falhas`service_not_shared`,`capability_changed` e lease ausente permanecem registradas por época. |
| Notebook | Assets originais833.499.307bytes e runtime llama-cpp-python0.3.19 preparados; construtor CT2 real CPU int8→**int8_float32**. Geração Qwen/offload efetivo e Piper do caso remoto ainda não validados. Greeting de startup foi excluído. |
| HTTP direto | Ainda sem fluxo nativo autenticado qualificado. GET LAN plaintext foi bloqueado pela CSP; falta endpoint HTTPS LAN confiável suportado. USB/ADB são controle, não transporte medido; host/host ICE por si só não resolve LAN versus overlay. |
| Matriz e capacidade | K1 inclui LLM local real; equivalência Whisper ONNX/CT2 e defaults nativos continuam desconhecidos. K2 independe do LLM local, mas entrada híbrida ainda não qualificada. K3 independe dos modelos do telefone, mas falhou na rota. As seis condições cumulativas permanecem inelegíveis para900. O único piloto local prevê69,75h/900 no comportamento frio observado, sem warmups/cooling/falhas; previsão remota indisponível. |

**Próximo passo técnico:** em futura janela finita do telefone, comprovar bootstrap/sessão após atualização, verificar lease consumer v8a no par autorizado e executar um único fluxo remoto correlacionado até WAV. Não repetir o piloto local aprovado, reconstruir tudo ou trocar modelos. A janela antiga não pode ser reutilizada ou estendida. Ainda será necessário qualificar HTTPS LAN e as entradas híbridas antes de suas respectivas condições.

Fonte do APK: base`ebde3a8acf6315f920d03593845f17a1fc65a733` +closure v2383+reparos isolados v1–v8a. SHA remoto publicado continua desconhecido; nenhuma escrita Git, fonte compartilhada ou campanha congelada foi alterada. Root continua integrador e Main foi preservado. [Manifesto de fontes e patches](FINAL-SOURCE-MANIFEST-20261022.json).

Os **61 arquivos públicos** finais foram copiados e verificados nos dois repositórios: ZIP236.203bytes, SHA256`90e4441fd579cfe6e894693ea3403b6e69da84a300f0f7407da6c18548598c91`; cópia de58frames/10,0s com recibo atômico, prefixos e originais preservados. Não inclui env/config/credenciais/APK/modelos. [Custódia](evidence/window-final-public-dual-v346/COPY-RECEIPT.json), [verificação dos61 arquivos](evidence/final-saved-data-check-v347.json), [histórico dos6 casos remotos](FINAL-REMOTE-CASE-HISTORY-20261022.json), [instalação atual](INSTALL-UPDATE-20261022.json), [devolução HOME](evidence/cleanup-home-only-v344/result.json), [parada dos serviços](evidence/owner-window-retirement-read-v260/result.json), [pipeline local/WAV](PHONE-LOCAL-FILE-AUDIO-QUALIFIED-20261022.json), [resumo estruturado](FINAL-SETUP-20261022.json).

Todos os checkpoints abaixo são **histórico de execução**, inclusive mensagens antigas sobre START ausente, convite vazio, Root implementar reparo, temperatura bloqueante ou serviços ainda ativos; o estado final acima os substitui.

---

## 2026-10-22 10:32 UTC — atualização Android instalada; pareamento em verificação

A atualização normal do POCO terminou com `Success` às 10:31:39 UTC, sem apagar dados. O APK instalado tem SHA256 `b8f9a8a63b5adc6074b9806193134fe17b1bc0926b47c6e6fbb66cb02c7bc42f`, 749091842 bytes, mesmo pacote/assinatura; 13 observações não encontraram o instalador em primeiro plano. Isso comprova esta atualização e não promete ausência universal de confirmações futuras.

A falha real anterior foi `Pairing message belongs to a stale connection`, após abertura de canal. A correção isolada v7 vincula SAS/reconexão ao papel SDP efetivo e substitui a conexão nativa quando rollback não é suportado. Cinco testes focados, treze testes do adaptador/arquivo de áudio, build do SDK, typecheck do aplicativo e build APK passaram. Falhas intermediárias e correções das referências de pacotes foram preservadas em v277/v284/v288; nenhum código compartilhado ou campanha congelada foi alterado.

O serviço próprio v225 foi encerrado normalmente antes de iniciar v286, com a mesma identidade/modelos/configuração e reutilização da chave API canônica existente, que havia sido omitida do ambiente isolado. A verificação nativa real após a atualização está em andamento; ainda não há caso remoto qualificado nem 900 medições. O piloto local de áudio já concluído não foi repetido. O limite original continua 11:57:25.269652 UTC.

Recibos: `evidence/read-build-install-v293/result.json`, `evidence/restore-existing-auth-service-epoch-v292/result.json`, `repairs/android-native-pairing-role-v7/MANIFEST.json`.

Pareamento real em execução — 2026-10-22T10:04:04.521918+00:00

A conclusão anterior de que convite vazio/401 exigiam ação externa era prematura e foi superada. O fluxo ordinário já está autorizado: operação nativa real gravou a senha existente no Keystore Android, corrigiu o campo canônico signalingUrl e salvou perfil webrtc-only com mesma sala/broker/identidade, preservando perfil offline e sem alterar grants. [Operação real v266](evidence/configure-phone-private-room-v266/result.json). O app encontrou identidade do outro peer, mas o leitor mantido do produto mostra negotiating / negotiation_timeout antes de SAS; diagnóstico da conexão existente em andamento, sem reconexão duplicada/modelos/pilotos refeitos. [Estado real](evidence/read-pair-error-facts-v269/result.json).0 casos medidos; serviço v225 e prazo11:57:25.269652UTC preservados, Main intocado.

---

Estado atual — 2026-10-22T09:14:55.741147+00:00

**Instalação concluída; rotas distribuídas ainda NÃO prontas.** APK atual `dev.aurora.desktop.phonenotebook`1.0.0/code100/ARM64,749.091.842bytes SHA256`4049a4b997a1a2e1e8cfd7f6b06e2544658a4dfee386589ca83fcae6ed6e216f`. Uma substituição normal `adb install -r` terminou `Success` às08:35:26UTC; mesma assinatura57bee2b4… e SHA do APK instalado confere.13 observações sem instalador em primeiro plano, nenhum aceite automatizado/dado apagado; isso documenta esta atualização, sem garantia sobre futuras confirmações. Hook K3 real agora é `function` no APK instalado. [Instalação e readback](evidence/verify-current-native-hook-v247/result.json).

Fonte: `ebde3a8acf6315f920d03593845f17a1fc65a733 + source-closure-overlay-v2383 + android-bundled-model-rename-v1 + android-node-policy-initial-publication-v2 + android-finite-file-audio-v3 + android-finite-file-audio-v3a + android-k3-sdk-file-audio-v4 + android-k3-sdk-mode-v4a + android-k3-sdk-build-flag-v5 + android-k3-native-surface-v6`. SHA remoto continua desconhecido; cópia local exata autorizada, overlays isolados, fontes medidas antigas e Git compartilhado preservados. As duas últimas correções propagam a flag ao frontend realmente compilado e passam contexto nativo à detecção central de plataforma;5 testes usando o detector real, typecheck e build ARM64 passaram. [Patches v5](repairs/android-k3-sdk-build-flag-v5/MANIFEST.json), [v6](repairs/android-k3-native-surface-v6/MANIFEST.json), [logs completos nos dois hosts](evidence/current-setup-raw-dual-v255/COPY-RECEIPT.json).

| Verificação | Resultado real |
|---|---|
| Pipeline local no POCO | STT nativo → Qwen nativo → Piper nativo → WAV válido; pergunta correta, resposta **Paris**,279,0s;1 sucesso/2 tentativas de pipeline. Fonte/APK v3a específico, sem pooling com fonte atual. |
| Arquivo WAV |31.788bytes,PCM16 mono22050Hz,15.872frames, SHA a75537d2…; RMS2098,46,0 amostras saturadas conferidas independentemente no arquivo copiado. |
| Notebook STT |Construtor real CT2 carregou modelo base fixado, CPU, pedido int8 e backend efetivo int8_float32; não é um caso de transcrição. |
| Notebook LLM/TTS |Assets/runtime fixados preparados; offload/geração Qwen e síntese Piper desse serviço ainda sem chamada validada. |
| Pareamento P2P |UI normal aberta: convite vazio, Save invite desabilitado. Hook instalado recusa `android_file_audio_route_unavailable` antes de enviar áudio/modelos; sem par/ICE autenticado qualificado. |
| HTTP direto |CSP nativa bloqueia LAN plaintext. Falta endpoint LAN HTTPS confiável e conexão autenticada do mesmo par. Diagnóstico protegido sem credenciais retornou **401**; flag de config isolada NÃO descreve sozinha a proteção efetiva, serviço preservado. |
|900/capacidade |0 casos medidos. LOCAL observado prevê69,75h/900 antes de warmups/cooling/falhas; previsão distribuída desconhecida. Conversão Whisper ONNX→checkpoint CT2 exato e parte dos defaults LLM nativos não comprovados; K1/K2/matched900 continuam inelegíveis. Adapter K3 compilado/exposto, sem aceitação de rota/cancelamento/coorte900. |

[WAV e pipeline real](PHONE-LOCAL-FILE-AUDIO-QUALIFIED-20261022.json), [STT e LAN atuais](evidence/notebook-route-readiness-v251/result.json), [401 real](evidence/reconcile-http-auth-and-stop-v253/result.json), [convite ausente no UI](evidence/select-phone-requester-ui-v244/result.json), [recusa real de rota](evidence/phone-route-admission-v248/result.json). **Ação externa mínima:** no UI seguro normal da Aurora, usar o convite privado do Notebook Personal neste app e confirmar dispositivos/recursos de voz; nenhum código/credencial em chat/logs. Para HTTP, usar um HTTPS LAN confiável existente. Coding foi avisado pelo evento `msg_3d492826ca22`; nenhuma nova permissão START/recurso ou confirmação USB é necessária.

Telefone devolvido à tela inicial às08:59:42UTC,88%USB carregando26,4°C; sem coleta ocupando o aparelho. Serviço v225 PID271169 preservado, admissão v2398 válida; retirada normal configurada11:57:05, parada rígida **11:57:25.269652UTC**, sem extensão. Processo simples no worker PID354471 recolherá uma vez o recibo desse mesmo serviço às11:57:03, com0 comandos no telefone/0 inferências; encerramento futuro ainda NÃO alegado. [Devolução real](evidence/release-setup-phone-v256/result.json), [coletor finito](evidence/window-retirement-v260/status.json). Main/Waydroid/Git intocados.

Custódia: ZIP105.807bytes SHA a2a7814f… validado nos dois hosts;19 arquivos de builds/instalações/serviço, prefixos ativos explicitamente rotulados. Cópia completa com frames espaçados passou em7,978s; recuperação anterior solicitou só8 frames faltantes e preservou as falhas, sem repetir launches/modelos. [Smoke de dados reais](evidence/paced-public-custody-smoke-v261/COPY-RECEIPT.json), [histórico de recuperação](evidence/failure-and-custody-reconciliation-v258.json). Worker pasta33.14MiB/disco livre2,59GB às09:11, abaixo do teto100MiB e acima do piso2GiB.

Os estados antigos abaixo são históricos; instalação, áudio local e admissão pendente antigos estão superados por estes recibos.

---

Atualização v229/v230 — 2026-10-22T08:22:17.466476+00:00

A interface do app carregou após reload normal, sem exceção JavaScript. O hook distribuído ausente foi rastreado ao empacotador: a compilação manual do frontend ignorava a flag no beforeBuildCommand, posteriormente anulado. Reparo isolado de4 linhas propaga a flag apenas ao build debug autorizado; build v231 iniciado08:19UTC com2jobs, serviço v225 saudável/ocioso preservado, nenhuma inferência concorrente. APK instalado anterior preservado por checksum; sem repetir o piloto local. [Diagnóstico real](evidence/phone-boot-diagnosis-v229/result.json), [manifesto da correção](repairs/android-k3-sdk-build-flag-v5/MANIFEST.json).

---

Atualização verificada — 2026-10-22T08:14:11.951360+00:00

**Instalação concluída:** substituição normal `adb install -r` terminou `Success` às07:49:25UTC, uma tentativa, dados preservados. Pacote `dev.aurora.desktop.phonenotebook`1.0.0/code100/ARM64; APK749.091.842bytes SHA256`2c266c13caed324c9b7459c7cf479208db85b9e10045c098fd7c6664bcea5a4e` confere com o arquivo instalado; mesma assinatura57bee2b4… .14 observações sem instalador em primeiro plano, nenhum consentimento automatizado. USB continua`device` às08:11UTC. [Recibo real](evidence/reconcile-owner-service-v226/result.json).

**Áudio totalmente local no POCO passou:** arquivo fixo → STT nativo → Qwen nativo → Piper nativo → WAV válido, pergunta correta e resposta **Paris**, às07:19:54UTC. Total279,0s; STT133,7s, verificação/carga LLM54,4s, geração3,4s, TTS87,4s. Sessão encerrada e screen wake liberado. [Qualificação e limites](PHONE-LOCAL-FILE-AUDIO-QUALIFIED-20261022.json), [WAV real](evidence/native-case-raw-dual-v222/phone-file-audio-v213/output.wav), [custódia verificada nos dois repositórios](evidence/native-case-raw-dual-v222/COPY-RECEIPT.json).2 tentativas de pipeline,1 sucesso; falha anterior de wrapper preservada.0 casos medidos.900 com esse comportamento observado exigiriam cerca69,75h antes de warmups/cooling/falhas; vínculo da conversão ONNX Whisper ao checkpoint CT2 permanece desconhecido, portanto sem elegibilidade comparável inventada.

**Notebook v225 já ativo**, PID271169, saúde200 desde07:59, fontes/modelos fixos, broker privado existente e dados de identidade preservados. Sem repetição de launch. A admissão de recursos v2398 SHAfc40cdc1… está válida e já foi consumida/ACK; nenhuma nova permissão Root/START é necessária. Prazo rígido11:57:25.269652UTC, retirada normal prevista11:57:05. O build ARM64 v221, typecheck e4 testes de rota passaram; isso não prova conexão real.

**Pendência real:** app atualizado abriu sem botões/headings visíveis e hook de áudio distribuído ausente às08:12; diagnóstico de inicialização em andamento. HTTP LAN simples continua bloqueado por CSP; HTTPS confiável e P2P autenticado do mesmo par ainda não qualificados. Backend efetivo/modelos do notebook ainda sem carga validada. Nenhum pedido de ação do dono observado; Main intocado. Relatos antigos abaixo sobre ausência de áudio local ou admissão pendente estão superados por estes recibos.

---

Atualização real — 2026-10-22T06:56:16.255638+00:00

APK de reparo v3a instalado com Success06:43:02UTC, uma substituição normal; pacote1.0.0/code100/ARM64,749.091.846bytes SHA1aaabb06746a70247562040a265a4efa6b80dcc4dc8f1fb25a0fb9da881025d6. Mesma assinatura57bee2b4... e leitura do base.apk coincide;9 verificações sem instalador em primeiro plano, nenhum aceite automatizado. [Recibo completo](evidence/read-file-audio-update-v202/result.json). O build ARM64 passou; a tentativa de testes host ficou na compilação de dependências até o teto180s e não é aprovação de testes.

A chamada inicial de preparação nativa de Whisper ultrapassou180s antes do registro da instalação. Cache207.557.382bytes preservado, arquivos encoder/decoder/tokens já extraídos no aparelho, app encerrado com recibo; nenhum modelo de fala foi executado nessa tentativa. Uma recuperação finita usa o mesmo APK/cache, até600s por preparação e420s para uma única pipeline toda dentro do telefone, total1680s, sem novo download/rebuild. [Falha real](evidence/reconcile-native-pack-v206/result.json).

Piper: grafo serializado/operators/pesos e demais campos ONNX iguais ao modelo fixo; diferença de128bytes só em metadados de formato, config SHA141d612c... igual. Os dois hashes e o limite entre backends constam no [mapeamento](PHONE-SPEECH-MODEL-MAPPING-20261022.json). Whisper ONNX: vínculo da conversão ao checkpoint CT2 exato permanece desconhecido; a verificação atual é funcional, não elegibilidade automática para900comparável. LLM local já validado, sem repetir teste isolado.

Ainda0pilotos de áudio concluídos,0casos medidos. HTTP plaintextLAN bloqueado por CSP, P2P/autenticação ainda não qualificados, nova admissão de recursos Notebook pendente.23 arquivos completos de build/falha/testes agora têm cópias verificadas nos dois repositórios;11 linhas de potenciais atribuições sensíveis foram omitidas na cópia exportada, originais protegidos no Notebook preservados. Main intocado; parada fixa11:57:25.269652UTC, sem nova permissão START.

---

Atualização real / LLM local qualificado — 2026-10-22T06:18:52.206314+00:00

O POCO executou o Qwen exato no motor nativo llama.cpp: carga/verificação55,24s; pergunta fixa respondeu **Paris** em3,267s. Segundo pedido cancelado, mesmo requestId, término confirmado e sessão destruída. A classificação inicial do código de cancelamento foi corrigida pela correspondência exata com a fonte; recibo original preservado, sem repetir inferência. [Qualificação](PHONE-LOCAL-LLM-QUALIFIED-20261022.json), [execução real](evidence/read-phone-llm-v177/result.json).

APK atual748.190.718bytes SHA549f760f5ceec5bce629a075f4e28df1ed74da4e503be0d15407ff7f3e4bd662; atualização normal Success05:59:06UTC, mesmo certificado57bee2b4..., leitura do APK instalado coincide.13 observações sem instalador em primeiro plano, sem consentimento automatizado/dados apagados. Isto prova essa substituição; não garante ausência de confirmação em todas as futuras atualizações.

O teste real06:06:36 do GET de saúde HTTP LAN foi bloqueado por connect-src CSP ([recibo](evidence/http-policy-probe-v180/result.json)); exige caminho LAN HTTPS confiável suportado, sem enfraquecer segurança. Fluxos autenticados HTTP/P2P e arquivo→STT→LLM→TTS→WAV ainda não qualificados. Reparo isolado v3 prepara entrada de arquivo finita só no APK debug autorizado, reutilizando motores reais e mantendo autorização remota. Pacotes públicos ONNX baseint8/LJSmedium274.727.275bytes estão em aquisição direta no notebook1MiB/s, sem repetir os833MB já verificados.

Estados antigos contraditórios foram arquivados em evidence/status-reconciliation-v185; CURRENT-SETUP.json é o resumo reconciliado.0casos900. Início automático após prontidão já autorizado; prazo rígido11:57:25.269652UTC inclui toda preparação. Admissão de novos serviços Notebook pendente msg204c54ccc425; janela anterior encerrada. Main intocado.

---

Segundo reparo Android instalado — 2026-10-22T05:59:06.727395+00:00

A atualização normal do reparo de configuração foi concluída com`Success`, uma tentativa, dados preservados. SHA256 do APK instalado`549f760f5ceec5bce629a075f4e28df1ed74da4e503be0d15407ff7f3e4bd662` coincide com o build; mesma assinatura do app anterior. Novamente13 observações sem atividade de instalador em primeiro plano, sem clique automatizado. [Recibo](evidence/read-policy-update-v175/result.json).

Os13 testes Rust de persistência/CAS/durabilidade passaram; esses testes não qualificam áudio nativo. A fixture de testes ausente foi reposta exatamente do commit ebde (19.576bytes, SHA27a27beb5bc77d04d07852430346d3143c2f3c83494189eac0c35b4c613a15e5). Fonte atual:`ebde3a8acf6315f920d03593845f17a1fc65a733 + source-closure-overlay-v2383 + android-bundled-model-rename-v1 + android-node-policy-initial-publication-v2`; sem Gitwrites/sharedsourcewrites.

O Qwen exato está fisicamente no telefone com SHA57d199... verificado; a primeira cópia terminou de drenar após o recibo do clienteUSB, por isso um hash precoce divergente foi preservado e uma reconciliação posterior confirmou os563.036.064bytes sem repetir a cópia. Fonte anterior recusou sessão por falha na configuração nativa antes de carregar modelo; o novo teste lê primeiro essa configuração e só então tenta carga/geração/cancelamento. Nada foi declarado LLM funcional ou piloto arquivo→WAV antes desse resultado. Coleta0, prazo final fixo11:57:25.269652UTC.

---

Atualização Android real concluída — 2026-10-22T05:21:57.321998+00:00

**Substituição normal`adb install -r`: Success, exit0, uma tentativa,27s.** Pacote`dev.aurora.desktop.phonenotebook`, versão1.0.0/código100/ARM64, com dados preservados. SHA256 instalado coincide com o APK de reparo:`a40413544aa3080ff18b701493c90ab896d3cc86e8aeb085de52a31c63095ec9`. Certificado SHA256 antigo/novo igual:`57bee2b41e922fd1ee2fb08e1839ec3d423d78cc361afc22e2f1d11672293963`. Em13 observações não apareceu atividade de instalador em primeiro plano; nenhum clique/aceite foi automatizado. Isso documenta esta substituição e não garante ausência de confirmação em todas as futuras atualizações nem exclui interação humana entre observações. [Recibo](evidence/read-update-state-v149/result.json).

Fonte`ebde3a8acf6315f920d03593845f17a1fc65a733 + source-closure-overlay-v2383 + android-bundled-model-rename-v1`; SHA remoto continua desconhecido. Build v137 passou e encerrou todos os filhos; fontes/APKs/falhas anteriores preservados. Verificação de inicialização nativa em andamento; áudio/piloto/coleta ainda0. Início automático condicional autorizado até parada fixa11:57:25.269652UTC.

---

Instalação atual verificada — 2026-10-22T05:18:49.403780+00:00

USB`device`; pacote`dev.aurora.desktop.phonenotebook` instalado, versão1.0.0/código100/ARM64. App parado. Ainda era o APK anterior SHA`d830acbc44940743c19bab50c2bfecab0f810a3c197a23d5c95e0c980ae1ae6a`; a string de horário do Android tem relógio/fuso próprio e não é UTC do controlador. Assinatura diagnóstica Android`c0193540` não é SHA criptográfico de certificado. [Recibo atual](evidence/current-android-installation-v142/result.json).

Build de reparo v137 terminou com exit0 às05:19:17UTC,244.665s, APK748190722bytes. A primeira verificação de certificado falhou antes de qualquer instalação por Java não selecionado; ambiente Java17 foi corrigido apenas no subprocesso próprio, sem rebuild ou alteração global. Uma única substituição normal está preparada/executando, sem afirmar resultado antes do recibo.

---

Atualização real — 2026-10-22T05:10:22.515568+00:00

O POCO permanece autorizado por USB e conectado ao Wi‑Fi doméstico (05:06:41UTC). O build de reparo v126 concluiu a compilação Rust em1m03s e está no empacotamento Android; ainda não houve tentativa de atualização desse reparo. O v119 falhou por cache vendorizado com caminho absoluto antigo, preservado; cargo clean limitado ao pacote tauri-plugin-barcode-scanner regenerou esse cache, sem nova mudança de fonte.

Ainda não provado: substituição do APK sem confirmação, carga/geração do LLM no telefone, pareamento autenticado HTTP/P2P e fluxo de áudio nativo completo. Zero casos medidos. Início automático está autorizado após prontidão dentro do prazo fixo11:57:25.269652UTC.

---

Owner automatic window update — 2026-10-22T05:03:20.263104+00:00

Conditional automatic collection is authorized only after real readiness, within 2026-10-22T04:57:25.269652Z to **2026-10-22T11:57:25.269652Z**. Setup and pilots consume this same seven-hour window; no automatic extension or further sleep START gate. Native audio and authenticated HTTP/P2P are still unqualified, measured cases remain zero. Prioritize qualified K2/K3 independently of phone LLM. A necessary same-signed normal APK replacement will be tried once; unattended update support is unproven until its actual installer result.

Phone worker owns the isolated one-file native startup fix (atomic rename in place of Android-denied hard_link), not Root. Historical Root-implementation and wait-for-sleep text below is superseded. Exact repair manifest and old failed source/APK receipts are preserved.

---

**Current bounded check — instalação aceita; falha nativa de inicialização, 2026-10-22T04:37:02.020988+00:00**

A única repetição autorizada pelo dono instalou o mesmo APK com `Success`, exit0, às04:32:20UTC. Pacote `dev.aurora.desktop.phonenotebook`, versão1.0.0/code100, ARM64, targetSdk36; SHA256`d830acbc44940743c19bab50c2bfecab0f810a3c197a23d5c95e0c980ae1ae6a`. A Aurora anterior e os dados foram preservados. Nenhuma nova instalação, build ou mudança de segurança foi feita após a aceitação.

O `am start -W` abriu o componente real em850ms, mas o processo16861 abortou antes de concluir a consulta nativa. O contexto técnico limitado a esse novo app mostrou `Failed to setup app: error encountered during setup hook: Offline answers are unavailable`, seguido deSIGABRT. O PID não estava mais presente na observação seguinte. Não há pedido atual de aprovação do dono, problema USB/GPU ou gate85°C. O ponto exato da fonte é `lib.rs:9784–9791`, construtor `NativeLocalInferenceState::new` propagado fatalmente pelo setup; a subcausa interna ainda não está exposta pelo erro genérico. A correção de produto foi solicitada ao Root, único integrador, viaevento`msg_f312b3fa9a92`.

[Instalação confirmada](evidence/read-install-finish-v104/result.json), [lançamento real](evidence/launch-native-app-v105/result.json), [falha e PID](evidence/diagnose-test-app-v106/result.json), [panic exato](evidence/read-exact-native-abort-v107/result.json). Todos persistidos no notebook antes do relay. Nenhum áudio/microfone/conta/conteúdo pessoal foi acessado.0pilotos nativos,0casos900; nenhuma previsão de900 foi inventada.

O Root admitiu **uma** janela disjunta de boot<=900s e até2pilotos nativos, total<=1140s,2threads, sem compilador concorrente: [admissão original](evidence/ROOT-READINESS-ADMISSION-v2391.json), SHA256`68296887cab9183a92981b85ba58a7e14c8e456a0e2befbbb5f290da82f1995d`. O controlador de boot foi emitido às04:42:06UTC e será reconciliado por PID/status antes de qualquer repetição. Uma tentativa anterior do wrapper teve SyntaxError antes de executar código; seu recibo foi preservado e não iniciou serviço. MainK1 segue intocado. OwnerSleepSTART e janela noturna continuam ausentes.

---

**Current bounded check — APK compilado; atualização recusada por assinatura em 2026-10-22T04:21:31.211168+00:00**

O build nativo real v89 terminou exit0 às04:19:23UTC,569.20s,2jobs, pico4,937,416,704B RSS, sem processos de build próprios ativos. O backend exato `main.py` importou exit0; a configuração isolada validou o JSON Schema, sem serviços/modelos iniciados. GPU e USB seguem comprovados no recibo fresco v90.

APK debug/voice-live ARM64:747,895,794bytes, SHA256 `df30c725f9222810201c17dbd181f54b9262ed34e8bed50c8c21e1e637017052`, origem `ebde3a8acf6315f920d03593845f17a1fc65a733 + source-closure-overlay-v2383`, sem novo commit/remote SHA presumido. Bibliotecas Sherpa/ORT/llama e capacidades do teste nativo constam na proveniência real.

O `adb install -r` chegou ao aparelho autorizado e retornou `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: a Aurora já instalada usa outra assinatura. Nenhuma desinstalação, limpeza de dados, busca de chave ou mudança de segurança ocorreu. A alternativa em execução é empacotar a mesma fonte como `dev.aurora.desktop.phonenotebook` por override AGP restrito ao projeto isolado. O APK original está preservado por hardlink; a configuração do pacote de teste será registrada como identidade própria, sem pooling com o app antigo.

[Instalação real recusada e proveniência completa](evidence/install-pinned-apk-v95/result.json); [configuração privada preparada](evidence/prepare-isolated-backend-v93/result.json); [importação real e build concluído](evidence/probe-production-entrypoint-v94/result.json). Pilotos nativos HTTP/P2P e WAV final ainda0; nenhuma prontidão nativa ou duração noturna estimada foi inventada. Owner START continua ausente; main K1 intacto.

---

**Atualização verificada em 2026-10-22T04:10:22.437216+00:00: USB e GPU corrigidos; APK ainda compilando**

O comando real `adb -H 127.0.0.1 -P 5037 -s KBX8LNFUBE5XGQRG get-state` retornou `device` (exit0). Getprops confirmaram POCO `2412DPC0AG`, `arm64-v8a`, e Wi-Fi `192.168.1.94/24`. Os dois render nodes agora permitem leitura/escrita, o ICD NVIDIA e `libGLX_nvidia.so.0` estão disponíveis; o runtime exato llama-cpp-python0.3.19 encontrou AMD Radeon660M e RTX3050 e retornou `gpuOffloadBuildSupport=true`. Isto é capacidade observada, ainda sem chamada de modelo/offload medido.

O job existente `android-apk-build-v89` segue saudável, sem duplicação/restart:2jobs, teto8GiB RSS da árvore própria, deadlineUTC `2026-10-22T04:29:54.077196+00:00`; observados 1323384832B RSS e 21053329408B RAM disponível. A falha anterior v82 pelo teto customizado4GiB foi preservada. Temperatura89°C permanece telemetria; proteções do SO intactas.

Runtime Python, engines ARM64 e fontes/modelos exatos já preparados. A etapa restante é terminar o APK, instalar preservando dados e validar os fluxos nativos autenticados PHONE→NOTEBOOK HTTP/P2P, com áudio real até WAV válido e correlação das etapas. Até este recibo:0instalações por esta lane,0model calls,0pilotos,0casos900. O owner START noturno não foi recebido. Main K1 intacto, nenhuma ação do dono pendente nesta observação.

[Recibo fresco](evidence/owner-fixed-fresh-check-v90/result.json), SHA256 `559b4a4977f5b08a7543342da0d1a54a7593570bed7b5158f36d5070ff8c6731`, persistido nos dois repositórios antes do relay. As conclusões antigas negativas de USB/GPU abaixo são históricas e estão superadas.

---

**Fonte complementar resolvida — 2026-10-22T03:57:12.131645+00:00**

Root autorizou o overlay v2383 e a cópia única foi concluída às **03:54:01 UTC**: arquivo de 11.119 bytes e manifesto de 2.141 bytes, com ambos os SHA256 corretos e recibos nos dois hosts. O build novo fica em `android-build-ebde-plus-v2383`, identificado como **`ebde… + source-closure-overlay-v2383`**, preservando o snapshot de 1.959 arquivos e a falha anterior. [Cópia real](evidence/root-approved-source-closure-copy-v81/result.json). Não há espera por outra autorização de fonte.

Os engines Python/Vulkan, Sherpa ARM64 com patches e llama.cpp ARM64 estão compilados. O pacote de voz está gerando seus arquivos de distribuição; o novo APK aguarda essa etapa para compilar em série com 2 jobs/20 minutos. A GPU Vulkan do contexto Personal continua indisponível e nenhum modelo foi executado em CPU como substituição. Não há piloto/WAV/HTTP/P2P aceitos, previsão derivada de piloto ou START/900 noturno. O telefone não está ocupado por app/turno desta sessão e o HTTP principal permanece intacto.

---

**Resultado real após correção — 2026-10-22T03:37:44.949539+00:00**

O limite térmico personalizado foi removido e o trabalho prosseguiu: **llama-cpp-python 0.3.19 Vulkan compilado/importado**, comando em 499,14 s; **engine Android ARM64 Sherpa 1.13.5 com patches + ONNX Runtime 1.27.1 compilado**, exit 0 em 361,52 s, pico RSS da árvore 741 MB. [Runtime](RUNTIME-BUILD-RESULT-20261022.json), [engine real](evidence/actual-built-native-engine-20261022T0334/result.json) e [hashes dos binários](evidence/built-runtime-hashes-20261022T0340/result.json).

**A exposição GPU ainda impede aceitar o backend fixado:** o loader registra `No devices found` e `gpuOffloadBuildSupport=false`; ambos os render nodes estão sem acesso neste contexto Personal, e a biblioteca/ICD NVIDIA não estão disponíveis. Os checks dos caminhos existentes foram executados, sem alterações de driver/permissão/segurança. Não foi carregado modelo com fallback CPU. O bloqueio exato foi enviado ao coordenador para Coding/owner (`msg_ce699bffa93a`).

Os 1.959 arquivos e os 833.499.307 bytes dos insumos originais não foram baixados novamente. Os novos downloads foram **dependências nativas de empacotamento fixadas na própria fonte**, com SHA conferido: Sherpa, ORT, fonte llama.cpp Android e componentes Needle2 do APK; não são substitutos dos modelos de comparação. O APK está sendo preparado em cópia derivada isolada, preservando fonte imutável e checkout sujo. Ainda não há aceite de arquivo→STT→LLM→TTS→WAV nativo, HTTP autenticado ou P2P, nem previsão de duração de piloto. O telefone não foi ocupado por turno desta sessão; HTTP principal intacto; nenhum START/900 noturno.

---

**Execução real retomada — 22/10, 03:13 UTC**

USB autorizado confirmado novamente: `get-state=device`, API 36, arm64. O runtime exato `llama-cpp-python 0.3.19` está compilando com `GGML_VULKAN=ON/GGML_NATIVE=OFF`, 2 jobs e prazo até 03:33:04 UTC. Temperatura observada 88,75 °C, sem bloqueio personalizado. Não houve novo download de modelos/fonte; os 1.959 arquivos e os insumos verificados foram reutilizados. Resultado de build e qualificação nativa ainda pendentes. [Lançamento e USB atuais](evidence/owner-thermal-override-launch-20261022T0317/result.json).

---

**Correção do proprietário aplicada — 2026-10-22T03:11:46.836118+00:00**

O gate personalizado de 85 °C do notebook foi removido: temperatura será registrada e não impedirá build/piloto. Proteções do sistema permanecem intactas. Continuação com 2 jobs/20 minutos, memória/disco/RSS limitados, reutilizando os insumos já verificados; resultados reais serão acrescentados abaixo. Não há START para 900/noturno.

---

**Atualização solicitada — 22/10/2026, 02:53:35 UTC**

**O USB do POCO voltou a funcionar.** O controlador Personal existente listou `KBX8LNFUBE5XGQRG` como `device`; `get-state` retornou exit 0. O nó atual `/dev/bus/usb/003/015` está legível/gravável. Getprops reais confirmaram modelo `2412DPC0AG`, API 36 e `arm64-v8a`. Não há autorização USB pendente observada.

**O setup ainda não está pronto para testes nativos por limite térmico:** ACPI 90 °C e CPU `k10temp/Tctl` **90,75 °C**, acima do limite de 85 °C. Carga 1/5/15 minutos: **4,15 / 6,48 / 7,80**; RAM disponível 20,80 GB e disco livre 100,11 GB. A condição para retomar build/piloto não passou. Nenhum build, inferência ou app/turno foi iniciado, e não houve repetição de download ou verificação completa dos insumos já aprovados.

A fonte exata com 1.959 arquivos e os 833.499.307 bytes de insumos públicos continuam preparados. Depois do resfriamento ainda será necessário compilar/qualificar o runtime e o app e executar o piloto nativo HTTP/P2P; não há conclusão autônoma prometida. As notificações finais de setup e K1 permanecem pendentes; K1 pertence ao Root/Coding. A coleta de 900 casos segue sem START.

[Recibo atual, com custódia nos dois hosts](evidence/owner-fresh-check-20261022T025329/result.json) e [estado desta atualização](LATEST-OWNER-UPDATE.json). Nenhuma permissão, chave, daemon, rede ou processo do teste principal foi alterado.

---

**22/10, 01:45 UTC — arquivos prontos; setup nativo ainda não pronto**

O notebook Personal baixou diretamente dos originais públicos os oito arquivos fixados: **833.499.307 bytes**, todos com tamanho e SHA256 confirmados. Isso inclui Whisper base, Qwen3.5-0.8B Q4_0, Piper/configuração e a fonte oficial do llama-cpp-python 0.3.19. O download terminou às 01:21:25 UTC, sem transferência de modelos pelo worker ou desktop. Outros sete artefatos de build passaram seus hashes; as ferramentas foram instaladas no venv isolado, e os pacotes Vulkan originais foram extraídos apenas no prefixo do projeto. [Recibo real](evidence/read-assets-runtime-20261022T012132/result.json).

**Bloqueio físico atual:** às 01:45:13 UTC, o controlador Personal respondeu normalmente, mas o inventário estava vazio e `get-state` do POCO retornou exit 1, `device not found`. Não há Xiaomi USB exposto nesse contexto; o proxy Orca aprovado também está vazio. O servidor mudou externamente para PID 48127, `/usr/lib/android-sdk/platform-tools/adb`. Não foi observado estado `unauthorized` ou diálogo de aprovação. A ação mínima é restaurar a exposição USB/controlador já autorizada do aparelho. [Comandos e metadados atuais](evidence/current-usb-server-20261022T012515/result.json).

**Bloqueio térmico:** o notebook permanece próximo de 94,25 °C. Compilação e piloto exigem menos de 85 °C. A espera terminou automaticamente às 01:33:02 UTC por esse limite térmico, com status `FAILED_PRESERVED`, sem iniciar compilador ou carregar modelo. O recibo confirmou `ownBuildChildrenActive=false`. Há cerca de 100 GB livres e 18 GB de RAM disponíveis. Não encerrei trabalhos de outros contextos para resfriar a máquina.

**Fonte concluída:** o notebook recebeu 3.913.736 bytes em **70,80 segundos**, com os quatro hashes e os 43 quadros conferidos dentro da janela autorizada. O receptor encerrou e o terminal voltou a modo canônico com eco. A montagem posterior confirmou **1.959 arquivos, 37.949.666 bytes e todos os blobs/modos Git** do commit `ebde3a8acf6315f920d03593845f17a1fc65a733`. Foram reutilizados 759 blobs idênticos da base existente, sem escrita Git ou cópia de arquivos sujos. A checagem de sintaxe passou nos 224 arquivos Python do backend. [Cópia](evidence/source-delta-v33-copy-v2353-20261022/receiver-receipt.json), [montagem](evidence/assemble-exact-repair-20261022T014230/result.json) e [smoke salvo](evidence/source-device-smoke-20261022T014507/result.json). O SHA remoto segue desconhecido; a fonte é o snapshot local exato autorizado. Não há mais espera por fonte ou modelos compartilhados.

**Aceitação pendente:** app com fonte/build conhecidos, runtime Vulkan compilado, telefone acessível e fluxo nativo real de arquivo → STT → LLM → TTS → WAV válido em HTTP autenticado e P2P MQTT/ICE do mesmo par. Ainda há zero chamadas de modelo, zero pilotos e zero casos de coleta; não há previsão de duração derivada de piloto. Os checks antigos de ferramentas não contam como aceitação. A coleta integral exige o posterior sinal de dormir e um horário final explícito. O aparelho não foi ocupado por app/turno desta sessão e o teste principal permaneceu intacto.

As observações e falhas anteriores seguem preservadas abaixo. Os dados atuais estão em [ASSET-READINESS-20261022.json](ASSET-READINESS-20261022.json) e [SETUP-STATUS-20261022.json](SETUP-STATUS-20261022.json).

---

**Atualização22/10às01:09UTC: downloads públicos reais em andamento; fonte pequena preparada para envio**

O preparo dos modelos **já está executando diretamente no Personal notebook**, sem tráfego de modelos pelo worker/desktop. Às01:05:51UTC havia73,859,072bytes doQwen e73,924,608bytes doWhisper baixados das URLs originais fixadas; `whisper-base/config.json` já passou tamanho eSHA256 exatos. O processo próprioPID65019 tem prazo final01:23:28UTC,até2downloads/1MiB/s total,2CPUs de afinidade e prioridade reduzida. O status não equivale a hash aprovado dos arquivos ainda parciais. [Recibo real de progresso](evidence/read-data-progress-20261022T010543/result.json) e [manifesto completo fixado](DIRECT-PUBLIC-DOWNLOAD.json).

Os arquivosPiper foram vinculados ao commit original público`bae641dcb5a608cff81ccaf7ff018baaca1a33e1`,comSHA/tamanho originais; nenhuma voz foi substituída. A fonte oficialPyPI`llama_cpp_python-0.3.19.tar.gz` foi fixada em59,043,951bytes/SHA`6816e4a0a74ae9a356e7a0546e13147543f01f695c86a28d940e4b86519acf13` e está na mesma fila de aquisição. CMake/Ninja/scikit-build-core e três pacotesVulkan originais têm artefatos/tamanhos/hashes resolvidos em[PUBLIC-RUNTIME-BUILD-INPUTS.json](PUBLIC-RUNTIME-BUILD-INPUTS.json); não foram instalados globalmente. [Metadados reais de origem](evidence/mdns-build-inputs-20261022T010405/result.json).

A temperatura não é apenas um sensorACPI ambíguo: às01:02UTC o`k10temp/Tctl` também indicou92.375°C. Aquisição de arquivos usa limite95°C ou20°C abaixo do crítico informado peloSO,com consumo baixo; **build e piloto mantêm limite85°C**. Disco livre101GB eRAM disponível15.6GB. Não desliguei processos de outros trabalhos nem alterei drivers/segurança. É necessário o notebook ficar abaixo do limite de build para executar essa etapa.

**O telefone não está atualmente acessível.** O controladorPersonal executou`adb devices -l` às01:02UTC:lista vazia; o serial`KBX8LNFUBE5XGQRG` retornou`device not found` às01:01:48UTC,sem estado`unauthorized`. A descobertaADB/mDNS às01:04UTC também estava vazia. O sucessoUSB/Wi-Fi das00:14UTC permanece histórico e não é usado como estado atual. Não há evidência de diálogo de autorização; o caminhoUSB físico/controlador precisa voltar a expor o aparelho,sem reset/chaves/permissões por esta sessão. [Comandos atuais](evidence/current-controller-20261022T010210/result.json).

Root disponibilizou a fonte exata`ebde3a8acf6315f920d03593845f17a1fc65a733` em arquivo com commitPAX e manifesto1959arquivos,maisWAV fixo; total12,355,726bytes. A janela antiga expirou01:01:07UTC com **zero bytes de fonte transferidos**. O receptor foi realmente instalado no diretório isolado do notebook,sem escritaGit. Solicitei nova janela específica de420s para189envios textuais sequenciais peloOrca existente (`msg_f29918a89743`),com128KiB/s de carga/256KiB/s emlinha,um fluxo,hashes e prazo efetivo. Nenhum suposto suporte aSCP,credencial nova ou encaminhamento novo foi inventado. O download público dos modelos independe dessa janela.

**Ainda não pronto para os testes nativos:** fonte/app novos,buildVulkan0.3.19,USB atual e fluxo real arquivo→STT→LLM→TTS→WAV/HTTP autenticado/P2P continuam sem aceitação. Há zero chamadas de modelo e zero casos900; não existe previsão de horas derivada de piloto. O teste principal continua intacto. A coleta integral ainda exige o sinal de dormir e horário final explícitos.

---

**Atualização real22/10às00:16:58UTC: USB e Wi-Fi recuperados; preparo nativo aguarda liberação enfileirada**

**A correção do proprietário funcionou.** Às00:13:17UTC, o nó atual`/dev/bus/usb/003/014` estava legível/gravável peloPersonal; `adb -s KBX8LNFUBE5XGQRG get-state` retornou exit0`device`. Cinco getprops reais confirmaram Xiaomi/modelo2412DPC0AG,Android16/API36,arm64-v8a. O bloqueio anterior003/012 está encerrado por este recibo novo; não há açãoUSB pendente do proprietário.

Executei **`svc wifi enable` com exit0** e observei`wifi_on` mudar0→1. O telefone conectou automaticamente à rede já salva: **192.168.1.94/24 emwlan0**. A seleção de rota do telefone para192.168.1.250 usa`wlan0/src192.168.1.94`; a rota inversa do notebook usa`wlp4s0/src192.168.1.250`. Não houve leitura de senha/SSID,listagem de redes,alteração de conta ou tráfego de teste/celular. ADB continua sendo controle; seleções de rota ainda não provamHTTP autenticado/P2P.

Na janelaoffline efetivamente admitida,no novo venv rodei **imports binários reais** dectranslate2,numpy,onnxruntime,faster_whisper epiper.voice:exit0,sem carregar modelo,com picoRSS amostrado265,809,920bytes. CTranslate2 informa suporteCPU afloat32,int8 eint8_float32; isso confirma a capacidade do runtime,sem alegar o backend efetivamente carregado do modelo ausente. ONNXRuntime listaAzureExecutionProvider eCPUExecutionProvider;nenhum provedor remoto foi chamado. A versão exigidallama-cpp-python0.3.19 continua indisponível nos insumos locais;0.3.34não foi substituída.

**Pedido de execução permanece enfileirado e pendente:** [PENDING-RESOURCE-HANDOFF.json](PENDING-RESOURCE-HANDOFF.json),mensagemRoot`msg_bffcad56b7d4` às00:13:03UTC e notificação ao monitor original`msg_30f288b3477a` às00:17:05UTC. Solicitei a primeira liberação **natural após término/selagem** doHTTP atual: fonte exata<=12MiB/120s; modelos+áudio774,675,150bytes a<=2MiB/s/600s; trabalho local do notebook2jobs/20min; piloto depois de admissão concreta. Nenhuma cópia/build/inferência foi iniciada em recursos reservados. Não há janelaUTC de transferência concedida; o pedido não foi marcado concluído e não pede aoRoot/monitor inspeções do telefone nem pausa doHTTP.

A fonte exata e os arquivos continuam no caminho compartilhado reservado. O único cachellama observado é0.3.34,divergente de0.3.19; o commit`ebde3a8acf6315f920d03593845f17a1fc65a733` não existe no armazenamentoGit local do notebook. A consulta somente de configuraçãoSSH para o identificador já aprovado do worker não encontrou um alias configurado:nenhuma conexão foi tentada,não li chaves e não sondei transferências. O catálogo públicoOrca oferece terminais e encaminhamentos já aprovados; não inventei um serviço de arquivos,rota ou exposição nova.

**Aceitação que falta:** instalar app com fonte/build conhecidos,carregar os modelos exatos,completar um fluxo realarquivo→STT→LLM→TTS→WAV válido emHTTP autenticado eMQTT/ICE do mesmo par,correlacionar correção/estágios/recursos/parada e calcular previsão a partir desse piloto. Ainda há **zero chamadas de modelo,zero pilotos e zero900**; não existe previsão científica do telefone a inventar. O manifesto finito mantém início/fim/sinal de dormir ausentes e recusa coleta sem esses dados. Nenhum app/turno foi iniciado por esta sessão e não há subprocesso nosso de build/inferência ativo.

Novos recibos reais com cópia/checksum nos dois repositórios:

- [USB atual e cinco getprops bem-sucedidos](evidence/owner-fixed-now-20261022T001309/result.json).
- [Wi-Fi salvo ligado,IPv4 e seleção de rotaLAN](evidence/saved-wifi-after-fix-20261022T001345/result.json).
- [Imports binários reais e rota inversa do notebook](evidence/offline-binary-readiness-20261022T001646/result.json).

O teste principal permanece intacto. Os estados negativos abaixo são históricos e foram preservados.

---

**Tentativa de finalizar o setup: bloqueios externos confirmados — 2026-10-22T00:04:00UTC**

O setup **ainda não está pronto para os testes reais**. Continuei a execução autorizada: preparei o comando suportado para ligar o Wi-Fi salvo e criei de fato um venv isolado **Python3.11.14** em`deployment/ebde3a8acf6315f920d03593845f17a1fc65a733/.venv`, sem alterar o ambiente compartilhado ou o checkout sujo. SDK35/36 e NDK27.0.12077973 estão instalados; há GPUsAMD1002:1681 eNVIDIA10de:25a2 visíveis por metadados, sem inferir compatibilidade/aceleração. Notebook tinha18.38GBRAM disponíveis e101.13GB livres.

**Janela offline efetivamente usada:** o Root liberou até22/10às00:19:55UTC,limitada a2CPUs/4GiB,apenas para insumos já locais no notebook (`msg_fb6e25f5d33a`). Confirmei hostname,CPUAMD Ryzen5 7535HS/12threads,memória disponível18.41GB,disco101.22GB e kernel distinto do worker;nenhum namespaceWork foi acessado. No venv novo,configurei reutilização somente leitura dos cinco pacotes já instalados nas versões fixadas:ctranslate2 4.7.1,faster-whisper1.1.1,numpy2.2.6,onnxruntime1.20.1,piper-tts1.2.0. O próprioPython do ambiente de destino confirmou as cinco versões com exit0. O venv compartilhado permaneceu intacto.

A busca limitada no catálogo real do cacheUV encontrou **llama-cpp-python0.3.34**,enquanto o exigido é **0.3.19**;não instalei a versão diferente. O caminho de pacote0.3.19 e a fonte exata continuam ausentes nos locais inspecionados. Não hácmake/ninja/scikit-build-core locais nos caminhos/pacotes consultados. Essa janela não permite obter os insumos pela rede,nem transferir do worker/desktop,nem iniciar o piloto. O preparo terminou com **zero subprocessos de build ativos**,sem downloads,inferência ou substituição de modelo/runtime. [Resultado real do preparo offline](evidence/admitted-offline-runtime-20261022T000353/result.json) e [admissão finita original](evidence/NOTEBOOK-OFFLINE-RESOURCE-LEASE-v2328.json).

Dois fatos novos impedem completar o piloto:

1. **O telefone reenumerou e perdeu o acesso concedido ao nó anterior.** A mesma POCO/serialKBX8LNFUBE5XGQRG passou de`/dev/bus/usb/003/011` para **`/dev/bus/usb/003/012`**. Às23:54:12, o nó atual tinha UID/GID mapeados65534,modo0660 e`canRead=false/canWrite=false`; a interface ADB estava sem driver associado. O mesmo servidorLIBUSB/PID39627 permanece ativo,com inventário vazio e nenhum fdUSB. `get-state` retornou`device not found`. A tentativa autorizada de `svc wifi enable` parou no pré-requisito de conexão e **não executou a alteração**. Não foi observado diálogo Android de autorização. A ação mínima externa já foi enviada ao Coding/Root: restaurar a exposição já autorizada do controladorPersonal para o nó atual, mantendo o telefone conectado. Nenhuma permissão,chave,namespace ou daemon foi alterado por esta sessão.
2. **O Root negou explicitamente a janela de recursos compartilhados** na mensagem`msg_ada0dc77fde8` (23:52:13UTC): “The requested774455356B staging, and source transfer through those shared paths, are NOTadmitted duringcurrentfrozenmeasurement.” A decisão proíbe downloads,builds,transferências compartilhadas e inferência nesses recursos até liberação explícita após o teste atual. O commit exato`ebde3a8acf6315f920d03593845f17a1fc65a733` **não está no armazenamentoGit local do notebook** (`git cat-file -t`,exit128),portanto não há uma cópia local exata que permita contornar a transferência reservada. Não fiz sondagem de transferência,fetch,pull ou escritaGit.

Confirmei por`stat` que os **oito arquivos exatos**,incluindo áudio,estão preservados no worker:774,675,150bytes,com hashes de referência e destinos isolados no [plano de dependências](SETUP-DEPENDENCIES.json). Não os transferi ou reli integralmente durante a medição principal. A janela específica solicitada é fonte<=12MiB/120s,arquivos a<=2MiB/s/600s e trabalho local do notebook limitado a2jobs/20min,dependente da admissão real. A autorização do proprietário para o setup está registrada; não há nova pergunta de permissão para ações rotineiras.

O [script de Wi-Fi salvo](scripts/enable_saved_phone_wifi_v7.py) usa somente o serial exato e`svc wifi enable`,sem listar redes,lerSSID/senha ou alterar contas. O [preparo offline](scripts/notebook_offline_setup_v8.py) criou o ambiente e os requisitos fixados sem rede,build ou inferência. Os guias versionados`orca-cli` e`orca-emulator-android` orientam os controles suportados. Ruff passou para ambos os scripts; os bytes efetivamente executados e seus resultados estão preservados. A API de grafoGitNexus não está exposta nesta sessão; a consulta pontual de fonte foi feita com`git show` do commit fixado,sem reconstrução pesada de índice.

**Rechecagem final23:59:46UTC:** o serial continuou indisponível (`get-state`,exit1,`device not found`), e a ativação autorizada do Wi-Fi novamente não chegou a executar. [Comando real e recibo](evidence/saved-wifi-final-recheck-20261021T235938/result.json). Não houve suposição de diálogo ou repetição de modelo/teste nativo.

**Aceitação ainda pendente:** app de fonte/build conhecidos instalado,Wi-Fi/LAN efetivo,HTTP autenticado e MQTT/ICE do mesmo par,arquivo real passando porSTT→LLM→TTS eWAV válido,correlação de estágios/correção,parada nativa e previsão obtida do piloto. O commit fixado tem o ingressoAndroid`aurora_android_voice_live_test_inject_pcm`; não executei o harness com modeloOpenAI sintético e não contei os13checks de ferramentas como aceitação. A coleta900/overnight continua sem sinal de dormir/início/fim e não iniciou. O aparelho não foi ocupado por nenhum app/turno desta sessão; não há turno nativo nosso a cancelar.

Resultados reais,com custódia nos dois repositórios:

- [Tentativa de ativar Wi-Fi,interrompida antes da configuração](evidence/owner-enable-saved-wifi-20261021T235317/result.json).
- [Regressão observada do nóUSB003/012 e servidorLIBUSB](evidence/setup-controller-refresh-20261021T235405/result.json).
- [Venv realmente criado,fonte exata ausente e recursos do notebook](evidence/notebook-offline-setup-20261021T235617/result.json).
- [Decisão explícita de recursos do Root](evidence/root-resource-refusal-20261021T235213.json).

Nenhum teste principal foi pausado ou alterado. [Estado atual](ACTUAL-READINESS-20261021.json) e[LATEST-USB-CHECK.json](LATEST-USB-CHECK.json) substituem os estados históricos abaixo.

---

**Histórico preservado — sucessoUSB anterior e demais tentativas**

**Latest actual setup result: USB authorized and reachable — 2026-10-21T23:46:02UTC**

The existing Personal notebook controller now reaches the owner's **POCO X7 Pro**, serial **KBX8LNFUBE5XGQRG**. Actual `get-state` returned exit0 **device**; nonprivate `getprop` returned Xiaomi/model2412DPC0AG, **Android16/API36**, **arm64-v8a**. No USB approval or pairing action is needed.

The selected endpoint is `127.0.0.1:5037`; client/server are SDK37.0.0 build14910828. The current server is **PID39627**, UID1001/GID1002 with matching Personal network/user/mount namespaces and a USB fd open to `/dev/bus/usb/003/011`. It started externally at23:44:19 with **ADB_LIBUSB=1**, and `server-status` reports **LIBUSB, forced**. At23:40 the previous PID31031 used NATIVE and enumerated no phone despite fixed node permissions. Enumeration is now restored; the precise earlier native-backend failure was not isolated. This lane performed **no daemon restart, USB reset/rescan, permission/key/security change or namespace entry**. No further controller diagnosis is required for the present successful state.

| Actual readiness boundary | Fresh observation |
| --- | --- |
| USB identity/interface | Xiaomi POCO X7 Pro;2717:ff08;usb3-1;ADB interfaceff/42/01;node003/011 readable/writable |
| Phone properties | Model2412DPC0AG;Android16/API36;arm64-v8a;all five bounded getprops exit0 |
| Installed Aurora | `dev.aurora.desktop`,DEBUGGABLE,v1.0.0/code100,targetSDK36,updated2026-08-27;**source SHA unknown** |
| APK identity limit | Installed base.apk529,739,457bytes;SHA intentionally not computed because the bounded128MiB hash guard rejected it;no APK transfer |
| Phone power | USB charging;76%;34.6°C at23:45:16UTC |
| Direct LAN eligibility | **Phone Wi-Fi OFF**: `wifi_on=0`,no wlan0IPv4;route to notebook192.168.1.250 selects cellular`ccmni2` |
| Notebook LAN/source | Wi-Fi`wlp4s0`192.168.1.250/24;HEADdf23fd6e1f80e87dc45b6221bed87c00b4187e66;existing dirty files preserved |
| App/native route | No app installed/launched by this lane;native file-audio,cancel,actual model/stage/audio/HTTP/P2P proof still pending |
| Resource/collection | No build,model transfer,inference,pilot,warmup or measured case;main Root campaign untouched |

**Exact next action:** the owner must enable the phone's existing trusted Personal Wi-Fi for the required LAN route. This lane will not change network settings. The route command only selected a route and sent no measurement packets. USB remains control only. Neither ADB nor the cellular/overlay route qualifies as direct LAN HTTP or actual P2P evidence.

In parallel, Root's resource-owner decision is requested for finite disjoint source/runtime/model staging without pausing the current HTTP campaign. Exact approved local source remains`ebde3a8acf6315f920d03593845f17a1fc65a733` with remote SHA unknown;no fetch/pull/Git write occurred. The previously observed missing exact assets and llama runtime remain an independent readiness gate. This lane owns subsequent routine phone/app/native qualification; Root alone integrates any required product-source repair. The old installed app is not assumed to contain the approved native adapter. Full900/overnight execution still requires the later explicit owner start and finite availability window.

Actual command/source/window/checksum receipts are physically saved in both repositories:

- [Controller, process ownership, backend and successful serial command](evidence/adb-server-usb-diagnosis-20261021T234436/result.json):SHA256`e6a38b554147ebe59df6524b28fcdec20d3f8a58bfef14d4544ca6956423ee44`.
- [Actual successful phone properties, app version, battery and notebook dirty state](evidence/usb-authorized-readiness-20261021T234510/result.json).
- [Scoped package metadata, APK bound and actual Wi-Fi/route state](evidence/authorized-phone-route-app-20261021T234557/result.json).

[Current machine readiness](ACTUAL-READINESS-20261021.json) and [latest complete receipt bundle](LATEST-USB-CHECK.json) supersede older negative USB findings below. Targeted Ruff check/format passed for the two new read-only diagnostic scripts. No synthetic tooling test is counted as native readiness. The original failed Dispatch remains settled; this is direct-owner continuation with ordinary Root notifications, without a second completion signal.

---

**Preserved historical observations — superseded by the successful USB receipts above**

**Latest owner-requested single fresh check: 2026-10-21T23:40:20.290383+00:00**

**Change confirmed:** the current Personal environment can now read and write `/dev/bus/usb/003/011` (group1002). The USB access fix is visible. The remaining fresh result is ADB non-enumeration, not the prior node-permission denial and not an unauthorized-phone state. One physical USB disconnect/reconnect is a possible next discovery step; the cause is not yet proven.

Status: **KNOWN_SERIAL_NOT_REACHABLE_ON_EXPOSED_CONTROLLER**. `adb devices -l` exit 0; `adb -s KBX8LNFUBE5XGQRG get-state` exit 1.

Inventory stdout: `List of devices attached`. Selected-state result: `error: device 'KBX8LNFUBE5XGQRG' not found`.

Fresh USB metadata: `{"canRead": true, "canWrite": true, "exists": true, "gid": 1002, "manufacturer": "Xiaomi", "mode": "crw-rw----", "path": "/dev/bus/usb/003/011", "product": "POCO X7 Pro", "serial": "KBX8LNFUBE5XGQRG", "sysfsDevice": "3-1", "uid": 65534}`. Getprop results: `{}`.

[Actual result](evidence/owner-check-again-20261021T234015/result.json) and [fresh finite control intent](evidence/owner-check-again-20261021T234015/intent.json). SHA256 `1c9f619a8610b1da38093e5f63f4f5a8086c1076185ed0d959ec2211b72b48b4`; notebook copy was persisted before relay. Main campaign untouched; full overnight collection remains gated on owner start.

---

**Status: Fresh owner “fixed, check” execution — device still unreachable from this session**

A new finite read-only window was recorded under the renewed owner instruction, ending **2026-10-21T23:37:59.855047+00:00**. The earlier expired wrapper guard stopped before any command and is not evidence about the USB fix. Existing control terminal/incarnation was freshly fenced; no other terminal or lifecycle was adopted.

**Actual command results at2026-10-21T23:28:05UTC:**

| Command | Exit | Observed result |
| --- | --- | --- |
| `adb devices -l` |0| Successfully executed; attached-device list empty |
| `adb -s KBX8LNFUBE5XGQRG get-state` |1| `error: device 'KBX8LNFUBE5XGQRG' not found` |
| Private-free `getprop` requests |not run| Device is not reachable/authorized through this controller |

The attached hardware is still Xiaomi POCO X7 Pro, serial`KBX8LNFUBE5XGQRG`. Its current device node is **`/dev/bus/usb/003/011`**, changed from003/010. The existing ADB listener now has PID31031, changed from11271. The fresh process ran successfully, observed these changes and still reports that the Personal environment cannot read or write the new node (`crw-rw----`, mapped UID/GID65534). The existing listener itself responded normally; no server restart, key search, permission fix or namespace operation was performed by this check.

**Immediate reachability: not ready in the exposed Personal controller.** There is no evidence of an Android authorization dialog, and no successful device-property command can honestly be claimed. This is not a claim that host-wide ADB is unavailable. The existing host controller still needs an exposed supported route to this session. No new permission confirmation is pending.

The exact executed source, explicit commands, timestamps, exit codes, stderr and fresh window are saved in [actual command receipt](evidence/usb-exact-serial-fixed-20261021T232759/result.json) and [window/send intent](evidence/usb-exact-serial-fixed-20261021T232759/intent.json). Result SHA256: `026d9d69ee6d655bb16e0ec81809d2533d1d1cb79d9b68694e3ab66f47069c47`. The result was fsynced in the notebook repository before relay and is retained with an identical local checksum.

No app install/launch, native pilot, inference, source/model transfer or overnight case ran. Main Root HTTP/provider control is untouched. The current machine-readable state is [ACTUAL-READINESS-20261021.json](ACTUAL-READINESS-20261021.json). Earlier partial reports and all failed observations are preserved below and in the snapshot directory.

---

**Status: Current bounded check — POCO USB identified; exposed controllers cannot reach it**

On **2026-10-21**, the owner explicitly authorized read-only discovery and reuse of an existing Personal notebook host controller. No additional permission confirmation is pending.

The attached phone is **Xiaomi POCO X7 Pro**, hardware USB serial **KBX8LNFUBE5XGQRG**, read from the attached USB device's sysfs identity. The existing exposed ADB server at`127.0.0.1:5037` was actually queried: its inventory returned`OKAY` with no devices. The normal SDK command `adb -H 127.0.0.1 -P 5037 -s KBX8LNFUBE5XGQRG get-state` returned exit1: `error: device 'KBX8LNFUBE5XGQRG' not found`. No phone authorization dialog is established by this result, so no Allow action or pairing code is requested.

Existing-server metadata identifies Android platform tools37 and a Personal Podman-owned server process, with the current container user namespace and container marker. Its USB node`/dev/bus/usb/003/010` exists but is unreadable/unwritable by the Personal UID. The selected ADB server override variables are unset. This proves the exposed container server cannot currently reach the phone; it does **not** prove the physical host has no usable ADB controller.

Supported alternatives were checked. `orca emulator devices --worktree <existing Personal Aurora workspace> --json` returned an empty approved-device list. Project setup discovery exposes only`ssh:ssh-sem-notebook-personal` for this Personal notebook. Approved desktop discovery exposes only the separate Root desktop; no notebook desktop/controller is available there, and those Root targets were not used. `orca host list --json` is explicitly forbidden from this SSH worker. No alternate host ADB endpoint/socket or approved device selector is advertised through these surfaces. The installed host-spawn/distrobox-host-exec helpers were not executed because the owner's no-container-escape/no-namespace constraint remains in force; no generic host shell, namespace entry or privilege route was used.

**Exact next blocker:** an existing Personal host ADB controller must be reachable through an approved controller endpoint/socket or Orca device selector. **Minimal owner action:** provide that existing nonsecret endpoint/socket or selector. No key search, code, permission change, account switch, controller replacement, USB grant or invented confirmation dialog is needed or requested by this finding.

Actual setup is still **not ready**. ABI, Android version, Aurora app build/source and feature-consent state remain unreadable. There has been no app install/launch, native file-audio pilot or inference. The old wireless endpoint was not retried. Fresh notebook asset/runtime observations remain in [machine readiness](ACTUAL-READINESS-20261021.json): eight named model/audio candidates and the llama runtime/cache are unavailable at the inspected paths. Exact source/model/runtime acquisition and native pilot still need resource-safe execution; no heavy transfer/build ran and the main HTTP campaign remains independent. Full900/overnight collection still waits for the owner's explicit start and finite window.

The actual controller and serial queries, precise commands/errors, source bytes and updated report are preserved in both repositories. Prior failed/partial reports and all negative results remain intact under`evidence/usb-resume-20261021T2207/`. Historical2026-10-20 preparation follows below.

---

**Status: Partial setup — preparation verified; actual phone deployment blocked**

The isolated setup kit is physically present on the worker and Personal notebook. Notebook smoke verified19files/187,864bytes against manifest SHA`55b36d33ee52917cfc87495fcfda2f34fb7f915845988411766d289814c25df9`; all13tooling/saved-data checks passed on Python3.11.14 in0.101seconds. Its unadmitted collection preflight correctly refused with exit2. The same13checks passed locally, Ruff check/format passed and the local inference overlay validates the current configuration schema. These checks did not exercise a phone, native model or measured route.

The kit includes fenced sequential notebook controls, bounded readiness scripts, a schema-valid local-only service overlay, six-condition immutable manifest templates, a physical-resource dependency graph, append-only checksum custody, a finite guarded adapter orchestrator, saved-case type7 statistics/projection, safe-stop/return-phone instructions and a bounded native capability repair recommendation. It is under `thesis/phone-notebook/20261020/` locally and `.../prepared-kit-v1/` on the notebook. No shared product source, Git index, measured source/config, methodology or Ultragoal state was changed.

| Actual boundary | Observed result |
| --- | --- |
| Notebook | `skyron-notebook`, approved PersonalPodman namespace, Ryzen5 7535HS/12logical,32.79GBRAM/17.20GBavailable,101.96GBfree, load2.13,71°C, AC/100% at21:33:59UTC |
| Runtime | Existing Python3.11.14; five pinned packages match; `llama-cpp-python0.3.19` missing; accelerator/model offload unproven |
| Assets | All six named model/audio candidate paths absent; this is not a whole-host absence claim; exact model+auxiliary assets total774,455,356bytes before the219,794byte fixed WAV |
| Phone control | One existing-pair ADB connect to owner endpoint`100.64.0.4:35431` failed; `get-state` confirmed device not found; no reset, new pairing, code request or retry |
| Controller/topology | ADB37.0.0 in PersonalPodman, own daemon on127.0.0.1:5037; supplied phone address routes over`tailscale0` from100.64.0.2; notebook WiFi192.168.1.250/24 |
| Phone/app | Model, ABI, app build/source/APK, catalog and native capacity unknown because connection did not complete; no personal content read or Aurora app launched |
| Product routes | Authenticated PHONE→NOTEBOOK direct LAN HTTP and actual same-pair P2P MQTT/ICE remain unverified; ADB is not a measured route |
| Source | Root approved exact local commit`ebde3a8acf6315f920d03593845f17a1fc65a733`; push rejected, no verified remote SHA; no auth change, push retry, fetch/pull or source deployment here |
| Collection | Zero model calls, zero warmups, zero measured attempts; local baseline/applicable-cell eligibility unverified; no pilot timing or performance percentile invented |
| Owner window | Proposed seven to eight hours only; later explicit going-to-sleep start signal and exact UTC start/end/duration absent; collection refuses to start |

Three real readiness/connection/controller results were written and fsynced in the notebook repository before relay and verified against identical local checksums. Seven setup-copy receipts and the final notebook smoke have the same dual-host custody. The exact original code hashes for the first three discovery scripts are retained in their immutable intents; those scripts were subsequently formatted and their original bytes were not separately saved. All subsequent control operations retain exact executed source bytes. This limits source-text reconstruction for the preliminary metadata only; no scientific collection occurred.

The main remaining implementation gap is a qualified Android finite file-audio/native adapter with bounded cancellation and actual stage/audio/route/custody validation. The desktop hook is restricted to DEV+desktop-local+tauri-local; existing Android PCM injection is restricted to debuggable packages. [NATIVE-ADAPTER.md](NATIVE-ADAPTER.md) describes how Root can qualify the existing entrypoint or make a minimal source repair. No mock/Python substitute or native acceptance claim was made.

Root alone owns later resource admission. The approved local server-source subset is402files/7,524,554blob bytes, estimated7,849,472tar bytes, inventoried in [SOURCE-PIN.json](SOURCE-PIN.json). A requested future <=12MiB/120second copy-only window remains separate from the774MBasset/runtime/inference admission. Routine phone work remains in this lane; no Root phone checks or K3 campaign dependency were introduced.

All already-issued preparation commands completed. No native turn/app was started, so no phone occupation or task-owned native session needs cancellation. The ordinary ADB daemon remains available without pairing/security changes; it was not killed or reset. The notebook control lease expires22:02UTC and can be returned to Root early after this bounded branch. Actual deployment and overnight setup remain incomplete until the connection, source/resource, native route/capacity and later owner-start gates pass.

Entry points: [runbook](RUNBOOK.md), [machine readiness](ACTUAL-READINESS.json), [copy manifest](PREPARATION-MANIFEST.json), [notebook smoke](evidence/notebook-kit-smoke-2153/result.json), [tooling validation](evidence/tooling-validation-final.txt).

`make check-docs` failed on existing out-of-scope `docs/experiments/` report artifacts and a broken `campaign.py` link. Those files were already present at initial status and were preserved. No broad formatting, full product suite, build, model download or device campaign was run, because this lane changed only isolated preparation files and had no heavy-resource admission.


---

**Nova continuação autorizada — 2026-10-22T12:21:09.788710+00:00**

O proprietário renovou explicitamente execução nesta mesma sessão, seis horas prospectivas incluindo setup/coleta, parada rígida **2026-10-22T18:21:09.788710+00:00**, sem extensão automática. A janela e todos os recibos anteriores permanecem preservados. USB real `device`, Wi-Fi salvo ativo com rota wlan0 para Notebook, bateria99%USB/30,7°C, APKv8a ac043bd2… exato; memória Notebook23.952.867.328B/disco55.483.637.760B. Reusar fonte/modelos/pair, corrigir bootstrap/sessão, comprovar lease e um fluxo remoto STT→LLM→TTS→WAV/cancelamento/estágios antes de900 aplicável; não repetir pipeline local aprovado. [Autoridade](evidence/OWNER-CONTINUATION-v353.json), [estado ativo](ACTIVE-CONTINUATION-20261022.json), [verificação real](evidence/continuation-readiness-v353/result.json).


**2026-10-22 — fluxo remoto e cancelamento reais; coleta funcional distinta.** O piloto P2P físico retornou Paris e WAV válido em6.836,2ms, com três correlações nativas verificadas e arquivo bruto nos dois repositórios. A interrupção ativa foi observada como `canceled`/`reason_code=cancelled`; o recibo inicial do harness tinha apenas uma divergência de grafia, preservada e reconciliada sem repetir inferência. A nova coorte declara template embutido do GGUF e capacidade de API2 para uma única geração+controle, mantendo uma inferência por vez e todos os modelos/amostragem. Referência chatml antiga não foi combinada. Runner finito v440 lançado14:32:48Z, 15aquecimentos excluídos+900índices sem reposição, limite18:21:09Z. O estado e os primeiros resultados reais são acompanhados pelo recibo de custódia v442; conclusão900 ainda não presumida.

A [cobertura de instrumentação](evidence/INSTRUMENTATION-COVERAGE-v443.json) distingue tempo SDK de inferência nativa, mantém filas/TTFT/primeiro áudio e contadores não observados como UNKNOWN e registra os limites de GPU/rota. [WAV e três estágios](evidence/PILOT-RAW-JOIN-v419.json), [cancelamento real](evidence/CANCELLATION-QUALIFIED-v435.json), [janela e orçamento](evidence/WORKER-LIMITED-ALLOCATION-v426.json). Dados completos da coleta ficam no repositório do notebook; linhas reais compactas/correlações seguem para o worker sob crédito físico2MiB. Custódia integral de áudio no worker permanece pendente quando o piso exige.

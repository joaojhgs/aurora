**Atualização verificada em 2026-10-22T04:10:22.437216+00:00: USB e GPU corrigidos; APK ainda compilando**

O comando real `adb -H 127.0.0.1 -P 5037 -s KBX8LNFUBE5XGQRG get-state` retornou `device` (exit0). Getprops confirmaram POCO `2412DPC0AG`, `arm64-v8a`, e Wi-Fi `192.168.1.94/24`. Os dois render nodes agora permitem leitura/escrita, o ICD NVIDIA e `libGLX_nvidia.so.0` estão disponíveis; o runtime exato llama-cpp-python0.3.19 encontrou AMD Radeon660M e RTX3050 e retornou `gpuOffloadBuildSupport=true`. Isto é capacidade observada, ainda sem chamada de modelo/offload medido.

O job existente `android-apk-build-v89` segue saudável, sem duplicação/restart:2jobs, teto8GiB RSS da árvore própria, deadlineUTC `2026-10-22T04:29:54.077196+00:00`; observados 1323384832B RSS e 21053329408B RAM disponível. A falha anterior v82 pelo teto customizado4GiB foi preservada. Temperatura89°C permanece telemetria; proteções do SO intactas.

Runtime Python, engines ARM64 e fontes/modelos exatos já preparados. A etapa restante é terminar o APK, instalar preservando dados e validar os fluxos nativos autenticados PHONE→NOTEBOOK HTTP/P2P, com áudio real até WAV válido e correlação das etapas. Até este recibo:0instalações por esta lane,0model calls,0pilotos,0casos900. O owner START noturno não foi recebido. Main K1 intacto, nenhuma ação do dono pendente nesta observação.

[Recibo fresco](evidence/owner-fixed-fresh-check-v90/result.json), SHA256 `559b4a4977f5b08a7543342da0d1a54a7593570bed7b5158f36d5070ff8c6731`, persistido nos dois repositórios antes do relay. As conclusões antigas negativas de USB/GPU abaixo são históricas e estão superadas.

---


**Atualização solicitada — 22/10/2026, 02:53:35 UTC**

**O USB do POCO voltou a funcionar.** O controlador Personal existente listou `KBX8LNFUBE5XGQRG` como `device`; `get-state` retornou exit 0. O nó atual `/dev/bus/usb/003/015` está legível/gravável. Getprops reais confirmaram modelo `2412DPC0AG`, API 36 e `arm64-v8a`. Não há autorização USB pendente observada.

**O setup ainda não está pronto para testes nativos por limite térmico:** ACPI 90 °C e CPU `k10temp/Tctl` **90,75 °C**, acima do limite de 85 °C. Carga 1/5/15 minutos: **4,15 / 6,48 / 7,80**; RAM disponível 20,80 GB e disco livre 100,11 GB. A condição para retomar build/piloto não passou. Nenhum build, inferência ou app/turno foi iniciado, e não houve repetição de download ou verificação completa dos insumos já aprovados.

A fonte exata com 1.959 arquivos e os 833.499.307 bytes de insumos públicos continuam preparados. Depois do resfriamento ainda será necessário compilar/qualificar o runtime e o app e executar o piloto nativo HTTP/P2P; não há conclusão autônoma prometida. As notificações finais de setup e K1 permanecem pendentes; K1 pertence ao Root/Coding. A coleta de 900 casos segue sem START.

[Recibo atual, com custódia nos dois hosts](evidence/owner-fresh-check-20261022T025329/result.json) e [estado desta atualização](LATEST-OWNER-UPDATE.json). Nenhuma permissão, chave, daemon, rede ou processo do teste principal foi alterado.

---


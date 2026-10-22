## 2026-10-22 10:32 UTC — atualização Android instalada; pareamento em verificação

A atualização normal do POCO terminou com `Success` às 10:31:39 UTC, sem apagar dados. O APK instalado tem SHA256 `b8f9a8a63b5adc6074b9806193134fe17b1bc0926b47c6e6fbb66cb02c7bc42f`, 749091842 bytes, mesmo pacote/assinatura; 13 observações não encontraram o instalador em primeiro plano. Isso comprova esta atualização e não promete ausência universal de confirmações futuras.

A falha real anterior foi `Pairing message belongs to a stale connection`, após abertura de canal. A correção isolada v7 vincula SAS/reconexão ao papel SDP efetivo e substitui a conexão nativa quando rollback não é suportado. Cinco testes focados, treze testes do adaptador/arquivo de áudio, build do SDK, typecheck do aplicativo e build APK passaram. Falhas intermediárias e correções das referências de pacotes foram preservadas em v277/v284/v288; nenhum código compartilhado ou campanha congelada foi alterado.

O serviço próprio v225 foi encerrado normalmente antes de iniciar v286, com a mesma identidade/modelos/configuração e reutilização da chave API canônica existente, que havia sido omitida do ambiente isolado. A verificação nativa real após a atualização está em andamento; ainda não há caso remoto qualificado nem 900 medições. O piloto local de áudio já concluído não foi repetido. O limite original continua 11:57:25.269652 UTC.

Recibos: `evidence/read-build-install-v293/result.json`, `evidence/restore-existing-auth-service-epoch-v292/result.json`, `repairs/android-native-pairing-role-v7/MANIFEST.json`.


import { z } from 'zod/v4'

import { encryptedDataEnvelopeV1Schema } from './encrypted-envelope.js'
import {
  localDataCollectionHashesSchema,
  localDataExportV1Schema,
  localDataRecordCountsSchema
} from './export-v1.js'
import {
  conversationMessageRecordSchema,
  conversationRecordSchema,
  lightweightMemoryRecordSchema,
  localAuditRecordSchema,
  localDataRecordCollectionsSchema,
  localToolStateRecordSchema,
  peerGrantMetadataRecordSchema
} from './records.zod.js'

export function buildLocalDataJsonSchemaArtifact(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AuroraLocalDataContracts',
    type: 'object',
    additionalProperties: false,
    properties: {
      EncryptedDataEnvelopeV1: { $ref: '#/$defs/EncryptedDataEnvelopeV1' },
      ConversationRecord: { $ref: '#/$defs/ConversationRecord' },
      ConversationMessageRecord: { $ref: '#/$defs/ConversationMessageRecord' },
      LightweightMemoryRecord: { $ref: '#/$defs/LightweightMemoryRecord' },
      LocalToolStateRecord: { $ref: '#/$defs/LocalToolStateRecord' },
      PeerGrantMetadataRecord: { $ref: '#/$defs/PeerGrantMetadataRecord' },
      LocalAuditRecord: { $ref: '#/$defs/LocalAuditRecord' },
      LocalDataRecordCollections: { $ref: '#/$defs/LocalDataRecordCollections' },
      LocalDataRecordCounts: { $ref: '#/$defs/LocalDataRecordCounts' },
      LocalDataCollectionHashes: { $ref: '#/$defs/LocalDataCollectionHashes' },
      LocalDataExportV1: { $ref: '#/$defs/LocalDataExportV1' }
    },
    $defs: {
      EncryptedDataEnvelopeV1: z.toJSONSchema(encryptedDataEnvelopeV1Schema),
      ConversationRecord: z.toJSONSchema(conversationRecordSchema),
      ConversationMessageRecord: z.toJSONSchema(conversationMessageRecordSchema),
      LightweightMemoryRecord: z.toJSONSchema(lightweightMemoryRecordSchema),
      LocalToolStateRecord: z.toJSONSchema(localToolStateRecordSchema),
      PeerGrantMetadataRecord: z.toJSONSchema(peerGrantMetadataRecordSchema),
      LocalAuditRecord: z.toJSONSchema(localAuditRecordSchema),
      LocalDataRecordCollections: z.toJSONSchema(localDataRecordCollectionsSchema),
      LocalDataRecordCounts: z.toJSONSchema(localDataRecordCountsSchema),
      LocalDataCollectionHashes: z.toJSONSchema(localDataCollectionHashesSchema),
      LocalDataExportV1: z.toJSONSchema(localDataExportV1Schema)
    }
  }
}

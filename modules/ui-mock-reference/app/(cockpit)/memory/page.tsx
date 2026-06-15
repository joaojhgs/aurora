import { Database, HardDrive, Pin, Search, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/aurora/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PrivacyBadge, RouteBadge } from '@/components/aurora/status-badges'
import { conversations } from '@/lib/aurora/data'

const collections = [
  { name: 'Personal notes', records: 482, store: 'Local DB', privacy: 'personal' as const },
  { name: 'Work knowledge base', records: 1240, store: 'Server', privacy: 'sensitive' as const },
  { name: 'Journal', records: 96, store: 'Local DB', privacy: 'secret' as const },
]

export default function MemoryPage() {
  return (
    <div>
      <PageHeader
        title="Memory & Knowledge"
        description="Conversation history, RAG collections and retention. See exactly where each memory lives."
        actions={
          <Button variant="outline">
            <HardDrive className="size-4" />
            Retention policy
          </Button>
        }
      />
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid gap-4 md:grid-cols-3">
          {collections.map((c) => (
            <Card key={c.name}>
              <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Database className="size-4 text-primary" aria-hidden />
                  {c.name}
                </CardTitle>
                <PrivacyBadge privacy={c.privacy} className="px-1.5 py-0" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{c.records.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">records · {c.store}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="gap-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Conversation history</CardTitle>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input placeholder="Search conversations…" className="pl-9" />
            </div>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {conversations.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3 sm:px-6">
                {c.pinned && <Pin className="size-3.5 text-muted-foreground" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">{c.model} · {c.updated}</p>
                </div>
                <RouteBadge route={c.route} className="hidden px-1.5 py-0 sm:inline-flex" />
                <PrivacyBadge privacy={c.privacyClass} className="px-1.5 py-0" />
                <Button variant="ghost" size="icon" aria-label="Delete">
                  <Trash2 className="size-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Badge variant="outline" className="font-normal text-muted-foreground">
          Deleting a memory previews affected DB and RAG records before removal.
        </Badge>
      </div>
    </div>
  )
}

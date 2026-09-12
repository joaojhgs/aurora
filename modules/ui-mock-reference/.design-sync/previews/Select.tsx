import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Select defaultValue="edge-fast">
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Select a runtime" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Edge runtimes</SelectLabel>
            <SelectItem value="edge-fast">Edge — fast (2 hops)</SelectItem>
            <SelectItem value="edge-balanced">Edge — balanced</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Cloud runtimes</SelectLabel>
            <SelectItem value="cloud-standard">Cloud — standard</SelectItem>
            <SelectItem value="cloud-secure">Cloud — secure enclave</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

export function Open() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Select defaultValue="edge-fast" defaultOpen>
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Select a runtime" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Edge runtimes</SelectLabel>
            <SelectItem value="edge-fast">Edge — fast (2 hops)</SelectItem>
            <SelectItem value="edge-balanced">Edge — balanced</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Cloud runtimes</SelectLabel>
            <SelectItem value="cloud-standard">Cloud — standard</SelectItem>
            <SelectItem value="cloud-secure">Cloud — secure enclave</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

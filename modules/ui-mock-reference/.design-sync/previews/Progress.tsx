import {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Progress value={62} className="w-64" />
    </div>
  )
}

export function WithLabel() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Progress value={38} className="w-72">
        <div className="flex w-full justify-between">
          <ProgressLabel>Mesh sync</ProgressLabel>
          <ProgressValue />
        </div>
      </Progress>
    </div>
  )
}

export function Complete() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Progress value={100} className="w-72">
        <div className="flex w-full justify-between">
          <ProgressLabel>Diagnostics export</ProgressLabel>
          <ProgressValue />
        </div>
      </Progress>
    </div>
  )
}

export function JustStarted() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Progress value={4} className="w-72">
        <div className="flex w-full justify-between">
          <ProgressLabel>Pairing device&hellip;</ProgressLabel>
          <ProgressValue />
        </div>
      </Progress>
    </div>
  )
}

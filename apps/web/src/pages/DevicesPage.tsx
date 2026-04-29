import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Power,
  Server,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  devicesQuery,
  useRevokeDevice,
  type DeviceRow,
  type DeviceSystemInfo,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export function DevicesPage() {
  const q = useQuery(devicesQuery());

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
          <p className="text-sm text-muted-foreground">
            Machines that have paired with this OpenCara instance and can run
            agent jobs.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium text-muted-foreground">
            Pair a new device
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">Install the CLI:</p>
          <pre className="rounded-md bg-muted/30 p-3 text-xs">
            npm install -g opencara
            {"\n"}opencara
          </pre>
          <p className="text-muted-foreground">
            The CLI opens a browser tab back here to confirm the pairing,
            then starts accepting jobs as soon as you click confirm.
          </p>
        </CardContent>
      </Card>

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !q.data || q.data.devices.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No devices yet. Run <code>opencara</code> on a machine to pair it.
        </div>
      ) : (
        <div className="space-y-3">
          {q.data.devices.map((d) => (
            <DeviceCard key={d.id} device={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceCard({ device }: { device: DeviceRow }) {
  const revoke = useRevokeDevice();
  const [open, setOpen] = useState(false);
  const sys = device.systemInfo;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            {open ? (
              <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
            )}
            <Cpu className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{device.name}</CardTitle>
                <StatusBadge online={device.online} />
                {device.platform && (
                  <Badge variant="outline" className="font-normal">
                    {device.platform}
                    {device.version && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        v{device.version}
                      </span>
                    )}
                  </Badge>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {sys?.hostname && <span>{sys.hostname} · </span>}
                {sys ? (
                  <>
                    {sys.cpu.cores} cores · {fmtBytes(sys.memory.totalBytes)} RAM
                    {sys.disk && <> · {fmtBytes(sys.disk.totalBytes)} disk</>}
                  </>
                ) : (
                  <>
                    Last connected{" "}
                    {device.lastConnectedAt
                      ? formatRelative(device.lastConnectedAt)
                      : "never"}
                  </>
                )}
              </div>
            </div>
          </button>
          <Button
            size="sm"
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(`Revoke and delete "${device.name}"?`)) {
                revoke.mutate(device.id);
              }
            }}
          >
            <Power className="size-4" />
            {revoke.isPending ? "Removing…" : "Revoke"}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4 border-t pt-4">
          <div className="grid grid-cols-2 gap-4 text-xs md:grid-cols-3">
            <Field label="Last connected" value={
              device.lastConnectedAt ? formatRelative(device.lastConnectedAt) : "never"
            } />
            <Field label="Paired" value={formatRelative(device.createdAt)} />
            {device.systemInfoUpdatedAt && (
              <Field
                label="Metrics reported"
                value={formatRelative(device.systemInfoUpdatedAt)}
              />
            )}
          </div>

          {sys ? (
            <SystemInfoPanel info={sys} />
          ) : (
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              No system metrics reported yet — update the CLI on this device
              and reconnect to populate them.
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function SystemInfoPanel({ info }: { info: DeviceSystemInfo }) {
  const memUsedPct = pct(
    info.memory.totalBytes - info.memory.freeBytes,
    info.memory.totalBytes,
  );
  const diskUsedPct = info.disk
    ? pct(info.disk.totalBytes - info.disk.freeBytes, info.disk.totalBytes)
    : null;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <DetailCard icon={Server} title="OS">
        <Row label="Platform" value={`${info.os} · ${info.arch}`} />
        <Row label="Release" value={info.release} mono />
        <Row label="Hostname" value={info.hostname} mono />
        <Row label="Uptime" value={fmtUptime(info.uptimeSec)} />
      </DetailCard>

      <DetailCard icon={Cpu} title="CPU">
        <Row label="Model" value={info.cpu.model} mono />
        <Row label="Cores" value={`${info.cpu.cores}`} />
        <Row
          label="Speed"
          value={info.cpu.speedMhz ? `${info.cpu.speedMhz} MHz` : "—"}
        />
      </DetailCard>

      <DetailCard icon={MemoryStick} title="Memory">
        <Row label="Total" value={fmtBytes(info.memory.totalBytes)} />
        <Row label="Free" value={fmtBytes(info.memory.freeBytes)} />
        <UsageBar used={memUsedPct} />
      </DetailCard>

      <DetailCard icon={HardDrive} title="Disk">
        {info.disk ? (
          <>
            <Row label="Path" value={info.disk.path} mono />
            <Row label="Total" value={fmtBytes(info.disk.totalBytes)} />
            <Row label="Free" value={fmtBytes(info.disk.freeBytes)} />
            {diskUsedPct !== null && <UsageBar used={diskUsedPct} />}
          </>
        ) : (
          <div className="text-xs text-muted-foreground">unavailable</div>
        )}
      </DetailCard>

      <DetailCard icon={Network} title="Network" className="md:col-span-2">
        {info.ipAddrs.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No non-loopback IPv4 interfaces.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {info.ipAddrs.map((ip) => (
              <Badge key={ip} variant="outline" className="font-mono text-xs">
                {ip}
              </Badge>
            ))}
          </div>
        )}
      </DetailCard>
    </div>
  );
}

function DetailCard({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: typeof Cpu;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border bg-muted/20 p-3", className)}>
      <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 items-baseline gap-2 text-xs">
      <span className="col-span-1 text-muted-foreground">{label}</span>
      <span className={cn("col-span-2 truncate", mono && "font-mono")}>
        {value}
      </span>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function UsageBar({ used }: { used: number }) {
  // Tailwind doesn't precompile arbitrary [width:..%] classes that are dynamic,
  // so set the width via inline style. Colour shifts at 80% to flag pressure.
  const colour =
    used >= 90
      ? "bg-destructive"
      : used >= 80
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="mt-1.5 space-y-0.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full", colour)} style={{ width: `${used}%` }} />
      </div>
      <div className="text-[10px] text-muted-foreground">{used.toFixed(0)}% used</div>
    </div>
  );
}

function StatusBadge({ online }: { online: boolean }) {
  if (online) {
    return (
      <Badge className="gap-1">
        <span className="size-1.5 rounded-full bg-emerald-300" />
        online
      </Badge>
    );
  }
  return <Badge variant="secondary">offline</Badge>;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pct(used: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

import { useQuery } from "@tanstack/react-query";
import { Cpu, Power } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { devicesQuery, useRevokeDevice, type DeviceRow } from "@/lib/queries";
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
            Machines that have paired with this OpenKira instance and can run
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
            npm install -g @openkira/cli
            {"\n"}openkira register
          </pre>
          <p className="text-muted-foreground">
            The CLI opens a browser tab back here to confirm the pairing.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium text-muted-foreground">
            Your devices
          </CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : !q.data || q.data.devices.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No devices yet. Run <code>openkira register</code> on a machine to
              pair it.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Last connected</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.devices.map((d) => (
                  <DeviceRow key={d.id} device={d} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DeviceRow({ device }: { device: DeviceRow }) {
  const revoke = useRevokeDevice();
  const revoked = !!device.revokedAt;
  return (
    <TableRow>
      <TableCell>
        <Cpu className="size-4 text-muted-foreground" />
      </TableCell>
      <TableCell className="font-medium">{device.name}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {device.platform ?? "—"}
        {device.version && (
          <span className="ml-1 text-xs">v{device.version}</span>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {device.lastConnectedAt ? formatRelative(device.lastConnectedAt) : "never"}
      </TableCell>
      <TableCell>
        {revoked ? (
          <Badge variant="outline">revoked</Badge>
        ) : device.online ? (
          <Badge className="gap-1">
            <span
              className={cn(
                "size-1.5 rounded-full bg-emerald-300",
              )}
            />
            online
          </Badge>
        ) : (
          <Badge variant="secondary">offline</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        {!revoked && (
          <Button
            size="sm"
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(device.id)}
          >
            <Power className="size-4" />
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

import { useQuery } from "@tanstack/react-query";
import { meQuery, type User } from "@/lib/queries";

export function useUser(): User | null {
  const { data } = useQuery(meQuery());
  return data?.user ?? null;
}

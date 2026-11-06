import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { Body, Button, Field, Muted } from "./ui";

export function Reviews({
  roomId,
  participants,
}: {
  roomId: Id<"rooms">;
  participants: { _id: Id<"participants">; displayName: string }[];
}) {
  const reviews = useQuery(api.rituals.list, { roomId });
  const begin = useMutation(api.rituals.begin);
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <View style={{ gap: 8, paddingBottom: 12 }}>
      <Button
        kind="secondary"
        label={open ? "Close review composer" : "Independent review"}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <Muted>
            Answers stay sealed until everyone finishes. Reviews use a shared
            snapshot of tracked project files with execution tools disabled.
          </Muted>
          {participants.map((p) => (
            <Button
              kind="secondary"
              key={p._id}
              label={`${excluded.includes(p._id) ? "○" : "✓"} ${p.displayName}`}
              onPress={() =>
                setExcluded((ids) =>
                  ids.includes(p._id)
                    ? ids.filter((id) => id !== p._id)
                    : [...ids, p._id]
                )
              }
            />
          ))}
          <Field
            accessibilityLabel="Review request"
            placeholder="Review request"
            value={request}
            onChangeText={setRequest}
            multiline
          />
          <Button
            label="Start review"
            disabled={
              busy ||
              !request.trim() ||
              participants.every((p) => excluded.includes(p._id))
            }
            onPress={async () => {
              setBusy(true);
              try {
                const id = await begin({
                  roomId,
                  request,
                  participantIds: participants
                    .filter((p) => !excluded.includes(p._id))
                    .map((p) => p._id),
                });
                setRequest("");
                setError("");
                setOpen(false);
                router.push({ pathname: "/ritual/[id]", params: { id } });
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        </>
      )}
      {error ? <Body>{error}</Body> : null}
      {reviews?.map((r) => (
        <Button
          key={r._id}
          kind="secondary"
          label={`${r.status === "collecting" ? "Collecting" : "Complete"} · ${r.request.slice(0, 70)}`}
          onPress={() =>
            router.push({ pathname: "/ritual/[id]", params: { id: r._id } })
          }
        />
      ))}
    </View>
  );
}

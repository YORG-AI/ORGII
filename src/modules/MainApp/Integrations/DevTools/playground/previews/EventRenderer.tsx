import React, { Suspense, useMemo } from "react";

import SkeletonBar from "@src/components/Skeleton";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  COMPONENT_LOADERS,
  getChatLazyComponent,
} from "@src/engines/SessionCore/rendering/registry/events";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";

const EventLoadingFallback: React.FC = () => <SkeletonBar className="h-8" />;

const _lazyComponentCache = new Map<
  string,
  React.LazyExoticComponent<React.ComponentType<Record<string, unknown>>>
>();

function getLazyComponent(
  eventType: string
): React.LazyExoticComponent<
  React.ComponentType<Record<string, unknown>>
> | null {
  const cached = _lazyComponentCache.get(eventType);
  if (cached) return cached;

  const loader = COMPONENT_LOADERS[eventType];
  if (loader) {
    const lazy = React.lazy(loader);
    _lazyComponentCache.set(eventType, lazy);
    return lazy;
  }

  const fallback = getChatLazyComponent(eventType);
  if (fallback) {
    _lazyComponentCache.set(eventType, fallback);
    return fallback;
  }

  return null;
}

interface ResolvedEventRendererProps {
  event: SessionEvent;
  variant: EventVariant;
  EventComponent: React.LazyExoticComponent<
    React.ComponentType<Record<string, unknown>>
  >;
}

function ResolvedEventRenderer({
  event,
  variant,
  EventComponent,
}: ResolvedEventRendererProps) {
  return (
    <Suspense fallback={<EventLoadingFallback />}>
      <EventComponent event={event} variant={variant} />
    </Suspense>
  );
}

interface EventRendererProps {
  event: SessionEvent;
  variant: EventVariant;
}

export function EventRenderer({ event, variant }: EventRendererProps) {
  const eventType = getRegistryEventType(event);

  const EventComponent = useMemo(
    () => getLazyComponent(eventType),
    [eventType]
  );

  if (!EventComponent) {
    return (
      <div className="text-sm text-text-3">Unknown event type: {eventType}</div>
    );
  }

  return (
    <ResolvedEventRenderer
      event={event}
      variant={variant}
      EventComponent={EventComponent}
    />
  );
}

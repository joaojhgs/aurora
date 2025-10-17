"""Event Registry for type-safe message bus topics.

This module provides:
- Centralized registry of all valid topics
- Type validation for publish/subscribe operations
- Prevention of typos and invalid topic subscriptions
- Runtime validation against registered services
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_warning


class TopicDefinition(BaseModel):
    """Definition of a message bus topic.

    Attributes:
        topic: Full topic name (e.g., "TTS.Request")
        service: Service that owns this topic (e.g., "TTSService")
        message_type: Type of message (Event, Command, Query)
        payload_class: Expected payload class name
        description: Human-readable description
    """

    topic: str
    service: str
    message_type: str  # "Event", "Command", "Query"
    payload_class: str
    description: str = ""


class EventRegistry:
    """Registry for all message bus topics and their types.

    This class maintains a registry of all valid topics that can be
    published or subscribed to. Services register their topics during
    initialization, and the registry validates all publish/subscribe
    operations.
    """

    def __init__(self):
        """Initialize the event registry."""
        self._topics: dict[str, TopicDefinition] = {}
        self._service_topics: dict[str, list[str]] = {}
        self._wildcard_patterns: set[str] = set()

    def register_topic(self, topic: str, service: str, message_type: str, payload_class: str, description: str = "") -> None:
        """Register a topic in the registry.

        Args:
            topic: Topic name (e.g., "TTS.Request")
            service: Service name (e.g., "TTSService")
            message_type: Message type ("Event", "Command", "Query")
            payload_class: Payload class name (e.g., "TTSRequest")
            description: Human-readable description
        """
        if topic in self._topics:
            log_warning(f"Topic '{topic}' already registered, overwriting")

        definition = TopicDefinition(topic=topic, service=service, message_type=message_type, payload_class=payload_class, description=description)

        self._topics[topic] = definition

        # Track topics by service
        if service not in self._service_topics:
            self._service_topics[service] = []
        self._service_topics[service].append(topic)

        log_debug(f"Registered topic: {topic} ({service}.{payload_class})")

    def register_service_topics(self, service: str, topics: list[TopicDefinition]) -> None:
        """Register multiple topics for a service at once.

        Args:
            service: Service name
            topics: List of topic definitions
        """
        for topic_def in topics:
            self.register_topic(
                topic=topic_def.topic,
                service=service,
                message_type=topic_def.message_type,
                payload_class=topic_def.payload_class,
                description=topic_def.description,
            )

    def is_valid_topic(self, topic: str, allow_wildcards: bool = False) -> bool:
        """Check if a topic is valid.

        Args:
            topic: Topic to validate
            allow_wildcards: Whether to allow wildcard patterns (* and **)

        Returns:
            True if topic is valid or matches a wildcard pattern
        """
        # Exact match
        if topic in self._topics:
            return True

        # Wildcard patterns (for subscriptions)
        if allow_wildcards and ("*" in topic or "**" in topic):
            # Validate wildcard pattern format
            if self._is_valid_wildcard_pattern(topic):
                return True

        # Check if topic matches any registered wildcard pattern
        for registered_topic in self._topics.keys():
            if self._topic_matches(topic, registered_topic):
                return True

        return False

    def _is_valid_wildcard_pattern(self, pattern: str) -> bool:
        """Check if a wildcard pattern is valid.

        Valid patterns:
        - "Service.*" - all topics in a service
        - "Service.*.Subtopic" - wildcard in middle
        - "Service.**" - recursive wildcard

        Args:
            pattern: Pattern to validate

        Returns:
            True if pattern is valid
        """
        # Must have at least one non-wildcard component
        parts = pattern.split(".")
        has_real_part = any(p not in ("*", "**") for p in parts)
        return has_real_part

    def _topic_matches(self, topic: str, pattern: str) -> bool:
        """Check if a topic matches a pattern (with wildcards).

        Wildcard semantics:
        - "*" matches exactly one segment
        - "**" matches zero or more segments

        Args:
            topic: Topic to match
            pattern: Pattern (may contain wildcards)

        Returns:
            True if topic matches pattern
        """
        if "*" not in pattern and "**" not in pattern:
            return topic == pattern

        # Convert pattern to regex
        regex_pattern = pattern.replace(".", r"\.")
        regex_pattern = regex_pattern.replace("**", r".*")
        regex_pattern = regex_pattern.replace("*", r"[^.]+")
        regex_pattern = f"^{regex_pattern}$"

        return bool(re.match(regex_pattern, topic))

    def validate_publish(self, topic: str) -> bool:
        """Validate a topic for publishing.

        Args:
            topic: Topic to validate

        Returns:
            True if valid

        Raises:
            ValueError: If topic is not registered
        """
        if not self.is_valid_topic(topic, allow_wildcards=False):
            available = self.get_similar_topics(topic)
            similar_msg = f"\n  Similar topics: {', '.join(available)}" if available else ""
            raise ValueError(
                f"Topic '{topic}' is not registered in the event registry.{similar_msg}\n"
                f"  Register topics using registry.register_topic() before publishing."
            )
        return True

    def validate_subscribe(self, topic: str) -> bool:
        """Validate a topic for subscribing.

        Args:
            topic: Topic pattern to validate (may include wildcards)

        Returns:
            True if valid

        Raises:
            ValueError: If topic pattern is invalid
        """
        if not self.is_valid_topic(topic, allow_wildcards=True):
            available = self.get_similar_topics(topic)
            similar_msg = f"\n  Similar topics: {', '.join(available)}" if available else ""
            raise ValueError(
                f"Topic '{topic}' is not registered and doesn't match any registered topics.{similar_msg}\n"
                f"  Available topics: {', '.join(sorted(self._topics.keys())[:10])}"
            )
        return True

    def get_similar_topics(self, topic: str, limit: int = 5) -> list[str]:
        """Get topics similar to the given topic.

        Uses simple string similarity (common prefix/suffix).

        Args:
            topic: Topic to find similar matches for
            limit: Maximum number of suggestions

        Returns:
            List of similar topic names
        """
        if not topic:
            return []

        similar = []
        topic_lower = topic.lower()

        # Find topics with common prefixes or parts
        for registered in self._topics.keys():
            registered_lower = registered.lower()

            # Same prefix
            if registered_lower.startswith(topic_lower[:3]):
                similar.append(registered)
            # Contains similar part
            elif any(part in registered_lower for part in topic_lower.split(".") if len(part) > 2):
                similar.append(registered)

        return similar[:limit]

    def get_topic_info(self, topic: str) -> TopicDefinition | None:
        """Get information about a topic.

        Args:
            topic: Topic name

        Returns:
            TopicDefinition if found, None otherwise
        """
        return self._topics.get(topic)

    def get_service_topics(self, service: str) -> list[str]:
        """Get all topics for a service.

        Args:
            service: Service name

        Returns:
            List of topic names
        """
        return self._service_topics.get(service, [])

    def get_all_topics(self) -> list[str]:
        """Get all registered topics.

        Returns:
            List of all topic names
        """
        return sorted(self._topics.keys())

    def get_all_services(self) -> list[str]:
        """Get all registered services.

        Returns:
            List of service names
        """
        return sorted(self._service_topics.keys())

    def clear(self) -> None:
        """Clear all registered topics (for testing)."""
        self._topics.clear()
        self._service_topics.clear()
        self._wildcard_patterns.clear()


# Global registry instance
_registry: EventRegistry | None = None


def get_event_registry() -> EventRegistry:
    """Get the global event registry instance.

    Returns:
        EventRegistry singleton
    """
    global _registry
    if _registry is None:
        _registry = EventRegistry()
    return _registry


def set_event_registry(registry: EventRegistry) -> None:
    """Set the global event registry (for testing).

    Args:
        registry: EventRegistry instance to use
    """
    global _registry
    _registry = registry


# Export
__all__ = [
    "EventRegistry",
    "TopicDefinition",
    "get_event_registry",
    "set_event_registry",
]

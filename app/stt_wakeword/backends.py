# filepath: app/stt_wakeword/backends.py
"""Wake word detection backend implementations."""

from __future__ import annotations

import struct
from abc import ABC, abstractmethod
from typing import Optional

import numpy as np
from pydantic import BaseModel, Field

from app.helpers.aurora_logger import log_debug, log_error, log_info


class DetectionResult(BaseModel):
    """Result from wake word detection."""
    
    detected: bool = Field(
        description="Whether a wake word was detected"
    )
    wake_word_index: int = Field(
        default=-1,
        description="Index of the detected wake word (-1 if none)"
    )
    confidence: float = Field(
        default=0.0,
        description="Confidence score (0.0 to 1.0)"
    )


class WakeWordBackend(ABC):
    """Abstract base class for wake word detection backends."""
    
    def __init__(
        self,
        model_paths: list[str],
        sensitivity: float,
        wake_words: list[str],
    ):
        """Initialize wake word backend.
        
        Args:
            model_paths: Paths to wake word model files
            sensitivity: Detection sensitivity threshold
            wake_words: List of wake word names
        """
        self.model_paths = model_paths
        self.sensitivity = sensitivity
        self.wake_words = wake_words
    
    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the backend (load models, etc.)."""
        pass
    
    @abstractmethod
    async def detect(self, audio_data: bytes) -> DetectionResult:
        """Detect wake word in audio data.
        
        Args:
            audio_data: Raw audio data
            
        Returns:
            DetectionResult with detection information
        """
        pass
    
    @abstractmethod
    async def cleanup(self) -> None:
        """Cleanup backend resources."""
        pass


class OpenWakeWordBackend(WakeWordBackend):
    """OpenWakeWord detection backend implementation."""
    
    def __init__(
        self,
        model_paths: list[str],
        sensitivity: float,
        wake_words: list[str],
    ):
        """Initialize OpenWakeWord backend.
        
        Args:
            model_paths: Paths to .onnx model files
            sensitivity: Detection sensitivity threshold
            wake_words: List of wake word names
        """
        super().__init__(model_paths, sensitivity, wake_words)
        self._model: Optional[object] = None
    
    async def initialize(self) -> None:
        """Initialize OpenWakeWord backend."""
        try:
            from openwakeword.model import Model
            
            log_info("Loading OpenWakeWord models...")
            
            # Load custom models
            self._model = Model(
                wakeword_models=self.model_paths,
                inference_framework="onnx",
            )
            
            log_info(f"✅ OpenWakeWord models loaded: {self.wake_words}")
            
        except Exception as e:
            log_error(f"Failed to initialize OpenWakeWord: {e}", exc_info=True)
            raise
    
    async def detect(self, audio_data: bytes) -> DetectionResult:
        """Detect wake word using OpenWakeWord.
        
        Args:
            audio_data: Raw audio data
            
        Returns:
            DetectionResult with detection information
        """
        if not self._model:
            return DetectionResult(detected=False)
        
        try:
            # Convert bytes to numpy array
            pcm = np.frombuffer(audio_data, dtype=np.int16)
            
            # Run prediction
            self._model.predict(pcm)
            
            # Check prediction buffer for wake word
            max_score = -1.0
            max_index = -1
            
            wake_words_in_prediction = len(self._model.prediction_buffer.keys())
            
            if wake_words_in_prediction:
                for idx, mdl in enumerate(self._model.prediction_buffer.keys()):
                    scores = list(self._model.prediction_buffer[mdl])
                    if scores[-1] >= self.sensitivity and scores[-1] > max_score:
                        max_score = scores[-1]
                        max_index = idx
                
                if max_index >= 0:
                    return DetectionResult(
                        detected=True,
                        wake_word_index=max_index,
                        confidence=max_score,
                    )
            
            return DetectionResult(detected=False)
            
        except Exception as e:
            log_error(f"Error in OpenWakeWord detection: {e}", exc_info=True)
            return DetectionResult(detected=False)
    
    async def cleanup(self) -> None:
        """Cleanup OpenWakeWord resources."""
        self._model = None
        log_debug("OpenWakeWord backend cleaned up")


class PorcupineBackend(WakeWordBackend):
    """Porcupine detection backend implementation."""
    
    def __init__(
        self,
        model_paths: list[str],
        sensitivity: float,
        wake_words: list[str],
        buffer_size: int = 512,
    ):
        """Initialize Porcupine backend.
        
        Args:
            model_paths: Paths to .ppn model files
            sensitivity: Detection sensitivity threshold
            wake_words: List of wake word names
            buffer_size: Audio buffer size for processing
        """
        super().__init__(model_paths, sensitivity, wake_words)
        self._porcupine: Optional[object] = None
        self._buffer_size = buffer_size
    
    async def initialize(self) -> None:
        """Initialize Porcupine backend."""
        try:
            import pvporcupine
            
            log_info("Loading Porcupine wake word models...")
            
            # Convert model paths to keyword paths format expected by Porcupine
            self._porcupine = pvporcupine.create(
                keyword_paths=self.model_paths,
                sensitivities=[self.sensitivity] * len(self.model_paths),
            )
            
            log_info(f"✅ Porcupine models loaded: {self.wake_words}")
            
        except Exception as e:
            log_error(f"Failed to initialize Porcupine: {e}", exc_info=True)
            raise
    
    async def detect(self, audio_data: bytes) -> DetectionResult:
        """Detect wake word using Porcupine.
        
        Args:
            audio_data: Raw audio data
            
        Returns:
            DetectionResult with detection information
        """
        if not self._porcupine:
            return DetectionResult(detected=False)
        
        try:
            # Convert bytes to PCM format expected by Porcupine
            pcm = struct.unpack_from("h" * self._buffer_size, audio_data)
            
            # Process audio
            porcupine_index = self._porcupine.process(pcm)
            
            if porcupine_index >= 0:
                return DetectionResult(
                    detected=True,
                    wake_word_index=porcupine_index,
                    confidence=1.0,  # Porcupine doesn't provide confidence scores
                )
            
            return DetectionResult(detected=False)
            
        except Exception as e:
            log_error(f"Error in Porcupine detection: {e}", exc_info=True)
            return DetectionResult(detected=False)
    
    async def cleanup(self) -> None:
        """Cleanup Porcupine resources."""
        if self._porcupine:
            try:
                self._porcupine.delete()
            except Exception as e:
                log_error(f"Error cleaning up Porcupine: {e}")
        
        self._porcupine = None
        log_debug("Porcupine backend cleaned up")

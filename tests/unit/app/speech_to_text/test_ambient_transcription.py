import time
import unittest
from unittest.mock import Mock, patch, MagicMock
import numpy as np
from collections import deque

from app.speech_to_text.audio_recorder import AudioToTextRecorder


class TestAmbientTranscription(unittest.TestCase):
    """Test cases for ambient transcription functionality"""

    def setUp(self):
        """Set up test fixtures"""
        self.transcription_results = []
        self.ambient_callback = Mock()
        
    def test_ambient_transcription_disabled_by_default(self):
        """Test that ambient transcription is disabled by default"""
        with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._start_thread'):
            with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._audio_data_worker'):
                with patch('torch.cuda.is_available', return_value=False):
                    with patch('torch.hub.load'):
                        with patch('faster_whisper.WhisperModel'):
                            recorder = AudioToTextRecorder(
                                use_microphone=False,
                                spinner=False,
                                no_log_file=True
                            )
                            
                            self.assertFalse(recorder.enable_ambient_transcription)
                            self.assertIsNone(recorder.ambient_thread)
                            self.assertIsNone(recorder.ambient_audio_buffer)

    def test_ambient_transcription_enabled_initialization(self):
        """Test that ambient transcription initializes correctly when enabled"""
        with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._start_thread'):
            with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._audio_data_worker'):
                with patch('torch.cuda.is_available', return_value=False):
                    with patch('torch.hub.load'):
                        with patch('faster_whisper.WhisperModel'):
                            recorder = AudioToTextRecorder(
                                use_microphone=False,
                                spinner=False,
                                no_log_file=True,
                                enable_ambient_transcription=True,
                                ambient_transcription_interval=10,
                                ambient_buffer_duration=5,
                                on_ambient_transcription=self.ambient_callback
                            )
                            
                            self.assertTrue(recorder.enable_ambient_transcription)
                            self.assertEqual(recorder.ambient_transcription_interval, 10)
                            self.assertEqual(recorder.ambient_buffer_duration, 5)
                            self.assertEqual(recorder.on_ambient_transcription, self.ambient_callback)
                            self.assertIsNotNone(recorder.ambient_audio_buffer)

    def test_ambient_buffer_configuration(self):
        """Test that ambient buffer is configured with correct size"""
        with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._start_thread'):
            with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._audio_data_worker'):
                with patch('torch.cuda.is_available', return_value=False):
                    with patch('torch.hub.load'):
                        with patch('faster_whisper.WhisperModel'):
                            buffer_duration = 20
                            sample_rate = 16000
                            buffer_size = 512
                            
                            recorder = AudioToTextRecorder(
                                use_microphone=False,
                                spinner=False,
                                no_log_file=True,
                                enable_ambient_transcription=True,
                                ambient_buffer_duration=buffer_duration,
                                sample_rate=sample_rate,
                                buffer_size=buffer_size
                            )
                            
                            expected_maxlen = int((sample_rate // buffer_size) * buffer_duration)
                            self.assertEqual(recorder.ambient_audio_buffer.maxlen, expected_maxlen)

    def test_feed_audio_with_ambient_transcription(self):
        """Test that feed_audio method feeds data to ambient buffer when enabled"""
        with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._start_thread'):
            with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._audio_data_worker'):
                with patch('torch.cuda.is_available', return_value=False):
                    with patch('torch.hub.load'):
                        with patch('faster_whisper.WhisperModel'):
                            recorder = AudioToTextRecorder(
                                use_microphone=False,
                                spinner=False,
                                no_log_file=True,
                                enable_ambient_transcription=True,
                                ambient_buffer_duration=5
                            )
                            
                            # Mock audio data
                            test_audio = np.zeros(1024, dtype=np.int16)
                            
                            # Feed audio
                            recorder.feed_audio(test_audio)
                            
                            # Check that ambient buffer received data
                            self.assertGreater(len(recorder.ambient_audio_buffer), 0)

    def test_ambient_transcription_callback_format(self):
        """Test that ambient transcription callback is called with correct parameters"""
        # This test would need more complex mocking to test the actual callback invocation
        # For now, just test that the callback is properly stored
        test_callback = Mock()
        
        with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._start_thread'):
            with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._audio_data_worker'):
                with patch('torch.cuda.is_available', return_value=False):
                    with patch('torch.hub.load'):
                        with patch('faster_whisper.WhisperModel'):
                            recorder = AudioToTextRecorder(
                                use_microphone=False,
                                spinner=False,
                                no_log_file=True,
                                enable_ambient_transcription=True,
                                on_ambient_transcription=test_callback
                            )
                            
                            self.assertEqual(recorder.on_ambient_transcription, test_callback)

    def test_default_ambient_configuration(self):
        """Test default ambient transcription configuration values"""
        with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._start_thread'):
            with patch('app.speech_to_text.audio_recorder.AudioToTextRecorder._audio_data_worker'):
                with patch('torch.cuda.is_available', return_value=False):
                    with patch('torch.hub.load'):
                        with patch('faster_whisper.WhisperModel'):
                            recorder = AudioToTextRecorder(
                                use_microphone=False,
                                spinner=False,
                                no_log_file=True,
                                enable_ambient_transcription=True
                            )
                            
                            # Check default values
                            self.assertEqual(recorder.ambient_transcription_interval, 300)  # 5 minutes
                            self.assertEqual(recorder.ambient_buffer_duration, 30)  # 30 seconds


if __name__ == '__main__':
    unittest.main()
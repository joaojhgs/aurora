# Aurora Voice Models Directory

This directory contains the speech synthesis (TTS) and wake word detection model files used by Aurora.

## 🗣️ Text-to-Speech Models (Piper)

### English Models
- `en_US-lessac-medium.onnx` - English (US) medium quality voice (61MB)
- `en_US-lessac-medium.onnx.txt` - Configuration file for English TTS

### Portuguese Models  
- `pt_BR-faber-medium.onnx` - Portuguese (Brazil) medium quality voice
- `pt_BR-faber-medium.onnx.txt` - Configuration file for Portuguese TTS
- `pt_BR-edresson-low.onnx` - Portuguese (Brazil) low quality voice (smaller)
- `pt_BR-edresson-low.onnx.txt` - Configuration file for low quality Portuguese

## 🎯 Wake Word Detection Models

- `jarvis.onnx` - Main wake word model for "Jarvis" (202KB)
- `hey_jarvis_v0.1.onnx` - Alternative "Hey Jarvis" wake word model (1.3MB)
- `suh_mahn_thuh.onnx` - Additional wake word variant
- `suh_man_tuh.onnx` - Additional wake word variant

## 🔧 Configuration

### Text-to-Speech Setup
Configure TTS in your `config.json`:

```json
{
  "text_to_speech": {
    "model_file_path": "/voice_models/en_US-lessac-medium.onnx",
    "model_config_file_path": "/voice_models/en_US-lessac-medium.onnx.txt",
    "model_sample_rate": 22050
  }
}
```

### Wake Word Setup
Wake word models are configured in the main application:
- Primary model: `voice_models/jarvis.onnx`
- Customizable sensitivity and detection parameters

## 📦 Model Management

### Adding New TTS Voices

1. **Download from Piper Repository**: 
   - Visit: https://github.com/rhasspy/piper/blob/master/VOICES.md
   - Choose your language and quality level
   - Download both `.onnx` and `.onnx.txt` files

2. **Place in voice_models directory**

3. **Update configuration**:
   ```json
   {
     "text_to_speech": {
       "model_file_path": "/voice_models/your-new-voice.onnx",
       "model_config_file_path": "/voice_models/your-new-voice.onnx.txt"
     }
   }
   ```

### Quality Levels

| Quality | File Size | CPU Usage | Audio Quality |
|---------|-----------|-----------|---------------|
| **Low** | ~20MB | Low | Basic |
| **Medium** | ~50-80MB | Medium | Good |
| **High** | ~100MB+ | High | Excellent |

### Supported Languages

Currently included:
- 🇺🇸 English (US)
- 🇧🇷 Portuguese (Brazil)

Available from Piper:
- 🇩🇪 German, 🇫🇷 French, 🇪🇸 Spanish, 🇮🇹 Italian
- 🇳🇱 Dutch, 🇷🇺 Russian, 🇨🇳 Chinese, 🇯🇵 Japanese
- And many more...

## 🎛️ Sample Rates

Common sample rates by quality:
- **Low quality**: 16000 Hz
- **Medium quality**: 22050 Hz  
- **High quality**: 22050 Hz or 48000 Hz

⚠️ **Important**: Update `model_sample_rate` in config.json to match your voice model's sample rate (check the `.onnx.txt` file).

## 🔊 Wake Word Models

### Creating Custom Wake Words

1. **Use OpenWakeWord toolkit**
2. **Train on your voice samples**
3. **Export to ONNX format**
4. **Place in voice_models directory**
5. **Update main.py to reference your model**

### Performance Tips

- **Sensitivity**: Lower values = fewer false positives
- **Buffer Duration**: Affects wake word detection latency
- **Model Size**: Smaller models = faster detection

## ⚠️ Important Notes

- **File Sizes**: Voice models can be large (20MB-100MB+)
- **Local Storage**: All processing happens locally for privacy
- **Format**: Only ONNX format models are supported
- **Git Exclusion**: Model files are excluded from version control

## 🚀 Performance Optimization

1. **Choose appropriate quality** for your use case
2. **Use CUDA acceleration** for TTS if available
3. **Optimize sample rates** to match your audio hardware
4. **Consider model size** vs quality trade-offs

## 🔄 Switching Models

To change TTS voice:
1. Download new model files
2. Update `config.json` paths
3. Restart Aurora
4. Test with text-to-speech output

---

*For more information about voice models and setup, see the main Aurora README.md*

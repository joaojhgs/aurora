from RealtimeTTS import TextToAudioStream, GTTSEngine, GTTSVoice

voice = GTTSVoice(chunk_length=256, language="pt")
engine = GTTSEngine(voice)
stream = TextToAudioStream(engine)

def play (text):
    stream.feed(text)
    stream.play()
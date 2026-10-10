import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const PHASE_ONE_URL = 'https://us-central1-frontend-simplified.cloudfunctions.net/skinstricPhaseOne'
const PHASE_TWO_URL = 'https://us-central1-frontend-simplified.cloudfunctions.net/skinstricPhaseTwo'

const normalizePredictions = (response) => {
  // The endpoint may wrap its predictions in data/result/predictions.
  const candidates = [response, response?.data, response?.result, response?.predictions,
    response?.data?.data, response?.data?.predictions, response?.result?.data]
  const source = candidates.find((value) => value && typeof value === 'object' &&
    (value.race || value.age || value.gender || value.sex))
  if (!source) return null

  const parseGroup = (group) => {
    if (!group || typeof group !== 'object') return []
    const entries = Array.isArray(group)
      ? group.map((item) => [item.label ?? item.name ?? item.category, item.value ?? item.confidence ?? item.probability])
      : Object.entries(group)
    return entries
      .map(([label, raw]) => ({ label: String(label ?? ''), value: Number(raw) }))
      .filter(({ label, value }) => label && Number.isFinite(value) && value >= 0)
      .map(({ label, value }) => ({ label, value: value <= 1 ? value * 100 : value }))
      .sort((a, b) => b.value - a.value)
  }

  return {
    race: parseGroup(source.race),
    age: parseGroup(source.age),
    sex: parseGroup(source.gender ?? source.sex),
  }
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1])
  reader.onerror = () => reject(new Error('Could not read the selected image.'))
  reader.readAsDataURL(file)
})

function DiamondArrow({ direction = 'right' }) {
  return <span className="diamond"><span className="arrow">{direction === 'left' ? '◀' : '▶'}</span></span>
}

export default function App() {
  const [screen, setScreen] = useState('home')
  const [step, setStep] = useState('name')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('race')
  const [predictions, setPredictions] = useState(null)
  const [corrections, setCorrections] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [capturedImage, setCapturedImage] = useState(null)
  const galleryInputRef = useRef(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  useEffect(() => {
    if (step !== 'camera-view' || screen !== 'analysis' || capturedImage) return undefined
    let cancelled = false
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      })
      .catch(() => setError('Camera access was denied or is unavailable. Please allow camera access or use the gallery.'))
    return () => {
      cancelled = true
      stopCamera()
    }
  }, [step, screen, capturedImage])

  const goTo = (nextStep) => {
    setError('')
    setStep(nextStep)
  }

  const submitPhaseOne = async () => {
    const validText = /^[\p{L}\s'-]+$/u
    if (!validText.test(name.trim()) || !validText.test(location.trim())) {
      setError('Please enter a valid name and location using letters only.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await fetch(PHASE_ONE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), location: location.trim() }),
      })
      if (!response.ok) throw new Error(`Phase 1 request failed (${response.status}).`)
      goTo('upload')
    } catch (err) {
      setError(err.message || 'Could not submit your information. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const submitImage = async (base64Image) => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(PHASE_TWO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image }),
      })
      if (!response.ok) {
        const details = await response.text()
        throw new Error(`Image analysis failed (${response.status}). ${details.slice(0, 160)}`)
      }
      const result = await response.json()
      console.log('Skinstric Phase 2 response:', result)
      const parsed = normalizePredictions(result)
      if (!parsed || !Object.values(parsed).some((items) => items.length)) {
        throw new Error('The API responded, but no demographic predictions were found. Please check the console response format.')
      }
      setPredictions(parsed)
      setCorrections({})
      setSelectedCategory('race')
      stopCamera()
      goTo('results')
    } catch (err) {
      setError(err.message || 'Image analysis failed. Please try another image.')
    } finally {
      setBusy(false)
    }
  }

  const handleGalleryImage = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.')
      return
    }
    try {
      await submitImage(await toBase64(file))
    } catch (err) {
      setError(err.message)
    }
    event.target.value = ''
  }

  const takePicture = () => {
    const video = videoRef.current
    if (!video?.videoWidth || !video?.videoHeight) {
      setError('Camera is still loading. Please try again.')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    setCapturedImage(canvas.toDataURL('image/jpeg', 0.85))
    stopCamera()
  }

  const goBack = () => {
    setError('')
    if (step === 'demographics' || step === 'summary') goTo('results')
    else if (step === 'results') goTo('upload')
    else if (step === 'camera-view' || step === 'camera-permission' || step === 'camera-active') {
      setCapturedImage(null)
      stopCamera()
      goTo('upload')
    } else if (step === 'upload') goTo('location')
    else if (step === 'location') goTo('name')
    else setScreen('home')
  }

  const currentRows = predictions?.[selectedCategory] ?? []
  const selectedLabel = corrections[selectedCategory] ?? currentRows[0]?.label
  const selectedRow = currentRows.find((row) => row.label === selectedLabel) ?? currentRows[0]
  const displayLabel = (label) => label ? label.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Not available'
  const categoryTitle = useMemo(() => ({ race: 'RACE', age: 'AGE', sex: 'SEX' }), [])

  if (screen === 'home') {
    return (
      <main className="landing-page">
        <div className="dotted-shape dotted-left" aria-hidden="true" />
        <div className="dotted-shape dotted-right" aria-hidden="true" />
        <header className="header"><div className="brand"><span className="brand-name">SKINSTRIC</span><span className="intro">[ INTRO ]</span></div><button type="button" className="enter-code" title="Not part of the required test flow">ENTER CODE</button></header>
        <section className="landing-content"><h1>Sophisticated<br />skincare</h1></section>
        <button type="button" className="side-action discover-action" onClick={() => { setScreen('analysis'); goTo('name') }}><DiamondArrow direction="left" /><span>DISCOVER A.I.</span></button>
        <button type="button" className="side-action test-action" onClick={() => { setScreen('analysis'); goTo('name') }}><span>TAKE TEST</span><DiamondArrow /></button>
        <p className="landing-description">SKINSTRIC DEVELOPED AN A.I. THAT CREATES<br />A HIGHLY-PERSONALISED ROUTINE TAILORED TO<br />WHAT YOUR SKIN NEEDS.</p>
      </main>
    )
  }

  return (
    <main className="analysis-page">
      <header className="header"><div className="brand"><span className="brand-name">SKINSTRIC</span><span className="intro">{['results', 'summary', 'demographics'].includes(step) ? '[ ANALYSIS ]' : '[ INTRO ]'}</span></div></header>
      {['name', 'location', 'upload', 'camera-permission', 'camera-active'].includes(step) && <p className="analysis-label">TO START ANALYSIS</p>}

      {['name', 'location'].includes(step) && (
        <section className="analysis-center">
          <div className="analysis-diamond" /><div className="analysis-diamond diamond-middle" /><div className="analysis-diamond diamond-inner" />
          <div className="analysis-prompt">
            <span>{step === 'name' ? 'CLICK TO TYPE' : 'WHERE ARE YOU FROM?'}</span>
            <input className="analysis-input" type="text" aria-label={step === 'name' ? 'Your name' : 'Your location'} placeholder={step === 'name' ? 'Introduce Yourself' : 'Where are you from?'} value={step === 'name' ? name : location} onChange={(event) => step === 'name' ? setName(event.target.value) : setLocation(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { if (step === 'name' && name.trim()) goTo('location'); else if (step === 'location') submitPhaseOne() } }} />
          </div>
        </section>
      )}

      {['upload', 'camera-permission'].includes(step) && (
        <section className="upload-options">
          <button type="button" className="upload-option" onClick={() => goTo('camera-permission')}><span className="upload-diamond" /><span className="upload-icon camera-icon"><span className="camera-blade" /></span><span className="upload-text scan-text">ALLOW A.I.<br />TO SCAN YOUR FACE</span></button>
          <button type="button" className="upload-option" onClick={() => galleryInputRef.current?.click()}><span className="upload-diamond" /><span className="upload-icon gallery-icon"><span className="gallery-dot" /><span className="gallery-mountain" /></span><span className="upload-text gallery-text">ALLOW A.I.<br />ACCESS GALLERY</span></button>
          <input ref={galleryInputRef} type="file" accept="image/*" onChange={handleGalleryImage} style={{ display: 'none' }} aria-label="Choose face photo" />
        </section>
      )}

      {step === 'camera-permission' && (
        <div className="camera-permission"><p>ALLOW A.I. TO ACCESS YOUR CAMERA</p><div className="camera-permission-actions"><button type="button" onClick={() => goTo('upload')}>DENY</button><button type="button" onClick={() => { setCapturedImage(null); goTo('camera-view') }}>ALLOW</button></div></div>
      )}

      {step === 'camera-view' && (
        <div className="camera-view">
          {capturedImage ? <img src={capturedImage} className="camera-video" alt="Captured selfie" /> : <video ref={videoRef} className="camera-video" autoPlay playsInline muted />}
          {!capturedImage && <button type="button" className="take-picture" onClick={takePicture}><span>TAKE PICTURE</span><span className="take-picture-icon" /></button>}
          {capturedImage && <><div className="great-shot">GREAT SHOT!</div><button type="button" className="camera-proceed" disabled={busy} onClick={() => submitImage(capturedImage.split(',')[1])}><span>{busy ? 'ANALYZING...' : 'PROCEED'}</span><DiamondArrow /></button></>}
          <div className="camera-instructions"><p>TO GET BETTER RESULTS MAKE SURE TO HAVE</p><div className="camera-tips"><span>◇ NEUTRAL EXPRESSION</span><span>◇ FRONTAL POSE</span><span>◇ ADEQUATE LIGHTING</span></div></div>
          <button type="button" className="camera-back" onClick={goBack}><DiamondArrow direction="left" /><span>BACK</span></button>
        </div>
      )}

      {step === 'results' && (
        <div className="results-screen"><h2>A.I. ANALYSIS</h2><p>A.I. HAS ESTIMATED THE FOLLOWING.<br />FIX ESTIMATED INFORMATION IF NEEDED.</p>
          <div className="results-diamond-bg" /><div className="results-diamond-bg results-diamond-bg-inner" /><div className="results-diamond-bg results-diamond-bg-small" />
          <div className="results-diamond-menu"><button type="button" onClick={() => goTo('demographics')}>DEMOGRAPHICS</button><button type="button" disabled title="Not included in required demographics analysis">COSMETIC<br />CONCERNS</button><button type="button" disabled title="Not included in required demographics analysis">SKIN TYPE<br />DETAILS</button><button type="button" disabled title="Not included in required demographics analysis">WEATHER</button></div>
          <button type="button" className="get-summary" onClick={() => goTo('demographics')}><span>GET SUMMARY</span><DiamondArrow /></button>
        </div>
      )}

      {step === 'demographics' && (
        <div className="demographics-screen"><p className="demographics-label">A.I. ANALYSIS</p><h2>DEMOGRAPHICS</h2><p>PREDICTED RACE &amp; AGE</p>
          <div className="demographics-layout">
            <div className="demographics-left">{['race', 'age', 'sex'].map((category) => <button key={category} type="button" className={selectedCategory === category ? 'active-category' : ''} onClick={() => setSelectedCategory(category)}>{categoryTitle[category]}<small>{displayLabel(corrections[category] ?? predictions?.[category]?.[0]?.label)}</small></button>)}</div>
            <div className="demographics-center"><h3>{displayLabel(selectedLabel)}</h3><div className="confidence-circle"><span>{selectedRow ? `${selectedRow.value.toFixed(2)}%` : '—'}</span></div></div>
            <div className="demographics-right"><div className="confidence-header"><span>{categoryTitle[selectedCategory]}</span><span>A.I. CONFIDENCE</span></div>{currentRows.length ? currentRows.map((row) => <button type="button" key={row.label} className={`confidence-row ${row.label === selectedLabel ? 'selected' : ''}`} onClick={() => setCorrections((prev) => ({ ...prev, [selectedCategory]: row.label }))}><span>{displayLabel(row.label)}</span><span>{row.value.toFixed(2)}%</span></button>) : <p className="empty-predictions">No predictions available for this category.</p>}</div>
          </div><p className="demographics-help">Select a row to correct the predicted demographic category.</p>
        </div>
      )}

      {step === 'summary' && <div className="summary-screen"><h2>A.I. SUMMARY</h2><p>YOUR PERSONALIZED SKIN ANALYSIS</p><button type="button" onClick={() => goTo('demographics')}>VIEW DEMOGRAPHICS</button></div>}

      {error && <div className="app-error" role="alert">{error}</div>}
      {busy && <div className="app-loading" role="status">ANALYZING, PLEASE WAIT...</div>}
      {step !== 'camera-view' && <button type="button" className="analysis-back" onClick={goBack}><DiamondArrow direction="left" /><span>BACK</span></button>}
      {step === 'name' && <button type="button" className="analysis-proceed" disabled={!name.trim()} onClick={() => goTo('location')}><span>PROCEED</span><DiamondArrow /></button>}
      {step === 'location' && <button type="button" className="analysis-proceed" disabled={busy} onClick={submitPhaseOne}><span>{busy ? 'SUBMITTING...' : 'PROCEED'}</span><DiamondArrow /></button>}
    </main>
  )
}



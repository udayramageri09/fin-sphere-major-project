import { useEffect, useRef, useState } from 'react';
import { Camera, LogOut, Trash2, KeyRound, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth, passwordRecovery } from '../context/AuthContext';
import { usePrefersReducedMotion } from '../hooks/useMotionPreference';
import './Settings.css';
import Avatar from '../components/Avatar';
import { AVATAR_ACCEPT, avatarFileProblem, prepareAvatarImage } from '../utils/avatarImage';

const NAME_MAX = 80;
const FIELD = 'w-full rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-zinc-900 placeholder-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:border-blue-600 disabled:opacity-60';
const PRIMARY = 'inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500';
const SECONDARY = 'inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

function Section({ id, title, description, children }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-7 min-w-0 scroll-mt-24">
      <h2 id={id} className="text-xl font-bold tracking-tight text-zinc-900">{title}</h2>
      {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Message({ kind, children }) {
  if (!children) return null;
  const error = kind === 'error';
  return (
    <p role={error ? 'alert' : 'status'} data-testid={error ? 'settings-error' : 'settings-status'} className={`flex items-start gap-2 text-sm font-medium [overflow-wrap:anywhere] ${error ? 'text-red-700' : 'text-emerald-700'}`}>
      {error ? <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

// ── Profile: photo and display name, with an explicit Save / Cancel ─────────────────────────────────────────────────────
// Remounted per user (key), so one account's draft can never carry over to another.
function ProfileSection({ prepareImage }) {
  const { user, avatarUrl, updateProfile, uploadAvatar, removeAvatar } = useAuth();
  const saved = user?.displayName ?? '';
  const [name, setName] = useState(saved);
  const [photo, setPhoto] = useState(null);          // null = no change, 'remove', or { blob, previewUrl }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [picking, setPicking] = useState(false);
  const inFlight = useRef(false);
  const fileInput = useRef(null);
  const prepSeq = useRef(0);                        // identifies the newest photo choice, so a slower earlier one can never overwrite it

  const hasSavedPhoto = user?.avatarVersion != null;
  const shownPhoto = photo === 'remove' ? null : photo ? photo.previewUrl : avatarUrl;
  const hasPhotoToRemove = photo === 'remove' ? false : Boolean(photo) || hasSavedPhoto;
  const nameChanged = name.trim() !== saved;
  const dirty = nameChanged || photo !== null;

  useEffect(() => {                                  // a staged photo's preview URL is released when it is replaced, discarded, saved or the page closes
    const url = photo && photo !== 'remove' ? photo.previewUrl : null;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [photo]);
  useEffect(() => {                                  // warn before a reload or tab close would discard unsaved changes
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const choose = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';                         // so choosing the same file again still fires
    if (!file) return;
    setError(''); setStatus('');
    const problem = avatarFileProblem(file);
    if (problem) { setError(problem); return; }
    const mine = ++prepSeq.current;
    setPicking(true);
    try {
      const prepared = await (prepareImage ?? prepareAvatarImage)(file);
      if (mine !== prepSeq.current) { URL.revokeObjectURL(prepared.previewUrl); return; }   // superseded while preparing: drop it
      setPhoto(prepared);
    } catch (err) {
      if (mine === prepSeq.current) setError(err.message || 'We could not read that image. Try a different photo.');
    } finally {
      if (mine === prepSeq.current) setPicking(false);
    }
  };

  const removePhoto = () => {
    prepSeq.current++; setPicking(false);
    setError(''); setStatus('');
    setPhoto(hasSavedPhoto && photo !== 'remove' ? 'remove' : null);   // a staged new photo is discarded; a saved one is marked for removal
  };

  const cancel = () => {
    prepSeq.current++; setPicking(false);
    setName(saved); setPhoto(null); setError(''); setStatus('');
  };

  const save = async (event) => {
    event.preventDefault();
    if (!dirty || inFlight.current) return;          // no duplicate submissions
    inFlight.current = true;
    setBusy(true); setError(''); setStatus('');
    let done = '';
    try {
      if (photo === 'remove') { await removeAvatar(); done = 'Photo removed. '; setPhoto(null); }
      else if (photo) { await uploadAvatar(photo.blob); done = 'Photo saved. '; setPhoto(null); }
      if (nameChanged) {
        const updated = await updateProfile({ displayName: name.trim() });
        setName(updated?.displayName ?? name.trim());
      }
      setStatus('Profile saved.');
    } catch (err) {
      setError(`${done ? `${done}But your name was not saved. ` : ''}${err.message}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Section id="settings-profile" title="Profile">
      <form onSubmit={save} className="flex flex-col gap-6" noValidate>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Avatar size={72} name={name.trim() || saved} src={shownPhoto} label="Your profile photo" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={SECONDARY} onClick={() => fileInput.current?.click()} disabled={busy || picking}>
              <Camera size={16} aria-hidden="true" /> {hasPhotoToRemove ? 'Change photo' : 'Add photo'}
            </button>
            {(hasPhotoToRemove || photo === 'remove') && (
              <button type="button" className={SECONDARY} onClick={removePhoto} disabled={busy || picking}>
                <Trash2 size={16} aria-hidden="true" /> {photo && photo !== 'remove' ? 'Discard new photo' : photo === 'remove' ? 'Keep current photo' : 'Remove photo'}
              </button>
            )}
            <input ref={fileInput} type="file" accept={AVATAR_ACCEPT} onChange={choose} className="sr-only" tabIndex={-1} aria-label="Choose a profile photo (JPEG, PNG or WebP)" data-testid="avatar-input" />
          </div>
        </div>
        <p className="-mt-3 text-xs text-zinc-500">
          JPEG, PNG or WebP. Changes take effect when you save.
          {picking && ' Preparing your photo…'}
          {photo === 'remove' && ' Your photo will be removed when you save.'}
          {photo && photo !== 'remove' && ' This is a preview. It is saved when you press Save.'}
        </p>

        <div>
          <label htmlFor="settings-name" className="block text-sm font-semibold text-zinc-800">Display name</label>
          <p id="settings-name-hint" className="mt-1 mb-2 text-sm text-zinc-500">Optional. How you appear in FinSphere.</p>
          <input
            id="settings-name" className={FIELD} value={name} maxLength={NAME_MAX} autoComplete="nickname" aria-describedby="settings-name-hint settings-name-count"
            onChange={(e) => { setName(e.target.value); setStatus(''); }} disabled={busy} placeholder="e.g. Alex"
          />
          <p id="settings-name-count" className="mt-1 text-right text-xs text-zinc-400" data-testid="name-count">{name.length}/{NAME_MAX}</p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={PRIMARY} disabled={!dirty || busy} data-testid="save-profile">{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className={SECONDARY} onClick={cancel} disabled={!dirty || busy} data-testid="cancel-profile">Cancel</button>
            {dirty && !busy && <span className="text-sm text-amber-700 font-medium" data-testid="unsaved">You have unsaved changes.</span>}
          </div>
          <Message kind="error">{error}</Message>
          <Message kind="status">{status}</Message>
        </div>
      </form>
    </Section>
  );
}

// ── Account and security ────────────────────────────────────────────────────────────────────────────────────────────────
function AccountSection() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const sendLink = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setStatus(''); setError('');
    try {
      setStatus(await passwordRecovery('forgot-password', { email: user.email }));
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false; setBusy(false);
    }
  };

  return (
    <Section id="settings-account" title="Account & security">
      <div className="flex flex-col gap-6">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-800"><Mail size={16} aria-hidden="true" /> Sign-in email</p>
          <p className="mt-1 text-zinc-900 [overflow-wrap:anywhere]" data-testid="account-email">{user?.email}</p>
          <p className="mt-1 text-sm text-zinc-500">Your sign-in email.</p>
        </div>

        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-800"><KeyRound size={16} aria-hidden="true" /> Password</p>
          <p className="mt-1 mb-3 text-sm text-zinc-500">Get a password reset link by email. Valid for 15 minutes.</p>
          <button type="button" className={SECONDARY} onClick={sendLink} disabled={busy} data-testid="send-reset">{busy ? 'Sending…' : 'Email me a password reset link'}</button>
          <div className="mt-3 flex flex-col gap-2"><Message kind="error">{error}</Message><Message kind="status">{status}</Message></div>
        </div>

      </div>
    </Section>
  );
}

// ── Display ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function DisplaySection() {
  const { user, updateProfile } = useAuth();
  const systemReduces = usePrefersReducedMotion();
  const [pending, setPending] = useState(null);      // the value being saved (shown at once), or null
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const on = pending ?? Boolean(user?.reduceMotion);

  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setError(''); setPending(!on);
    try {
      await updateProfile({ reduceMotion: !on });
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false; setPending(null);
    }
  };

  return (
    <Section id="settings-display" title="Accessibility" description="Choose the motion level that is comfortable for you.">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id="reduce-motion-label" className="text-sm font-semibold text-zinc-800">Reduce dashboard animations</p>
          <p id="reduce-motion-hint" className="mt-1 text-sm text-zinc-500">Use fewer animations. Your device preference is always respected.</p>
          {systemReduces && <p className="mt-1 text-sm text-zinc-600" data-testid="system-reduces">Reduced motion is enabled on your device.</p>}
        </div>
        <button
          type="button" role="switch" aria-checked={on} aria-labelledby="reduce-motion-label" aria-describedby="reduce-motion-hint" onClick={toggle} data-testid="reduce-motion"
          className={`relative mt-1 h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${on ? 'bg-zinc-900 border-zinc-900' : 'bg-zinc-200 border-zinc-300'}`}
        >
          <span aria-hidden="true" className="absolute top-0.5 rounded-full bg-white shadow transition-all" style={{ height: 22, width: 22, left: on ? 24 : 2 }} />
        </button>
      </div>
      <div className="mt-3"><Message kind="error">{error}</Message></div>
    </Section>
  );
}

function Settings({ prepareImage }) {
  const { user, logout } = useAuth();
  const [section, setSection] = useState('profile');
  return (
    <div className="flex flex-col gap-6 max-w-5xl w-full mx-auto min-w-0" data-testid="settings-page">
      <header>
        <h1 className="text-3xl font-bold tracking-tight-display text-zinc-900">Settings</h1>
        <p className="text-zinc-500 mt-1">Manage your account and preferences.</p>
      </header>
      <div className="settings-layout">
        <nav aria-label="Settings sections" className="settings-menu">
          {[['profile', 'Profile'], ['account', 'Account & security'], ['display', 'Accessibility']].map(([id, label]) => (
            <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)} className={section === id ? 'is-active' : ''}>{label}</button>
          ))}
          <button type="button" onClick={logout} data-testid="settings-logout" className="flex items-center gap-2"><LogOut size={16} aria-hidden="true" />Log out</button>
        </nav>
        <div className="settings-content">
          <div hidden={section !== 'profile'}><ProfileSection key={user?.id} prepareImage={prepareImage} /></div>
          <div hidden={section !== 'account'}><AccountSection key={`account-${user?.id}`} /></div>
          <div hidden={section !== 'display'}><DisplaySection key={`display-${user?.id}`} /></div>
        </div>
      </div>
    </div>
  );
}

export default Settings;

"use client";

import {
  Bot,
  Eye,
  EyeOff,
  FlaskConical,
  Gauge,
  KeyRound,
  LogIn,
  LogOut,
  MailCheck,
  ShieldCheck,
  Sparkles,
  UserCircle,
  UserPlus,
  X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase/client';

type AuthMode = 'login' | 'signup' | 'forgot' | 'update';

type AuthUserState = {
  email: string | null;
  cargo: string | null;
};

type AuthProfile = {
  cargo: string | null;
};

const AUTH_OVERLAY_Z_INDEX = 2147483647;

const modalTitles: Record<AuthMode, string> = {
  login: 'Iniciar sesion',
  signup: 'Crear cuenta',
  forgot: 'Recuperar contrasena',
  update: 'Nueva contrasena',
};

const modalSubtitles: Record<AuthMode, string> = {
  login: 'Accede a HelioSat Mission Control.',
  signup: 'Crea tu cuenta y confirma el correo.',
  forgot: 'Te enviaremos un enlace seguro por email.',
  update: 'Define una contrasena nueva para tu cuenta.',
};

function getAuthRedirectUrl(mode?: 'recovery') {
  const url = new URL('/auth/callback', window.location.origin);

  if (mode) {
    url.searchParams.set('mode', mode);
  }

  return url.toString();
}

function getFriendlyAuthError(message: string) {
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('email not confirmed')) {
    return 'Confirma tu correo antes de iniciar sesion.';
  }

  if (normalizedMessage.includes('invalid login credentials')) {
    return 'Email o contrasena incorrectos.';
  }

  if (normalizedMessage.includes('password')) {
    return 'La contrasena no cumple los requisitos.';
  }

  return message;
}

function getUserInitial(email: string | null) {
  return email?.trim().charAt(0).toUpperCase() || 'U';
}

export function AuthControls() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<AuthUserState | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);

  const buildAuthUserState = useCallback(
    async (currentUser: { id: string; email?: string | null } | null): Promise<AuthUserState | null> => {
      if (!supabase || !currentUser) {
        return null;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('cargo')
        .eq('id', currentUser.id)
        .maybeSingle<AuthProfile>();

      return {
        email: currentUser.email ?? null,
        cargo: !error ? data?.cargo ?? null : null,
      };
    },
    [supabase],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let isMounted = true;

    const loadUser = async () => {
      const {
        data: { user: currentUser },
      } = await supabase.auth.getUser();

      if (!isMounted) {
        return;
      }

      setUser(await buildAuthUserState(currentUser));
    };

    void loadUser();

    const authResult = new URLSearchParams(window.location.search).get('auth');

    if (authResult === 'verified') {
      window.history.replaceState(null, '', window.location.pathname);
      queueMicrotask(() => {
        if (isMounted) {
          setMessage('Correo verificado. Sesion iniciada.');
        }
      });
    } else if (authResult === 'recovery') {
      window.history.replaceState(null, '', window.location.pathname);
      queueMicrotask(() => {
        if (isMounted) {
          setMode('update');
          setPassword('');
          setMessage('Introduce tu nueva contrasena.');
          setError(null);
          setIsOpen(true);
        }
      });
    } else if (authResult === 'error') {
      window.history.replaceState(null, '', window.location.pathname);
      queueMicrotask(() => {
        if (isMounted) {
          setError('No se pudo completar la verificacion del correo.');
          setIsOpen(true);
        }
      });
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void (async () => {
        setUser(await buildAuthUserState(session?.user ?? null));
      })();
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [buildAuthUserState, supabase]);

  const resetFormStatus = () => {
    setMessage(null);
    setError(null);
  };

  const openModal = (nextMode: AuthMode) => {
    resetFormStatus();
    setMode(nextMode);
    setPassword('');
    setIsPasswordVisible(false);
    setIsProfileMenuOpen(false);
    setIsOpen(true);
  };

  const closeModal = () => {
    setIsOpen(false);
    setIsSubmitting(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setError('Faltan las variables NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
      return;
    }

    setIsSubmitting(true);
    resetFormStatus();

    const normalizedEmail = email.trim();

    if (mode === 'signup') {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          emailRedirectTo: getAuthRedirectUrl(),
        },
      });

      if (signUpError) {
        setError(getFriendlyAuthError(signUpError.message));
      } else if (data.session) {
        setUser(await buildAuthUserState(data.user ?? null));
        setMessage('Cuenta creada. Sesion iniciada.');
        setIsOpen(false);
      } else {
        setMessage('Revisa tu correo para confirmar la cuenta.');
      }
    } else if (mode === 'forgot') {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: getAuthRedirectUrl('recovery'),
      });

      if (resetError) {
        setError(getFriendlyAuthError(resetError.message));
      } else {
        setMessage('Te hemos enviado un enlace para cambiar la contrasena.');
      }
    } else if (mode === 'update') {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });

      if (updateError) {
        setError(getFriendlyAuthError(updateError.message));
      } else {
        setMessage('Contrasena actualizada.');
        setPassword('');
        setIsOpen(false);
      }
    } else {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (signInError) {
        setError(getFriendlyAuthError(signInError.message));
      } else {
        setUser(await buildAuthUserState(data.user ?? null));
        setMessage('Sesion iniciada.');
        setIsOpen(false);
      }
    }

    setIsSubmitting(false);
  };

  const handleResendVerification = async () => {
    if (!supabase || !email.trim()) {
      return;
    }

    setIsSubmitting(true);
    resetFormStatus();

    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: {
        emailRedirectTo: getAuthRedirectUrl(),
      },
    });

    setIsSubmitting(false);

    if (resendError) {
      setError(getFriendlyAuthError(resendError.message));
    } else {
      setMessage('Correo de verificacion reenviado.');
    }
  };

  const handleSignOut = async () => {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    setUser(null);
    setMessage(null);
    setError(null);
    setIsOpen(false);
    setIsProfileMenuOpen(false);
  };

  const shouldShowPassword = mode === 'login' || mode === 'signup' || mode === 'update';
  const shouldShowEmail = mode !== 'update';
  const submitLabel = isSubmitting
    ? 'Procesando...'
    : mode === 'signup'
      ? 'Crear cuenta'
      : mode === 'forgot'
        ? 'Enviar enlace'
        : mode === 'update'
          ? 'Actualizar contrasena'
          : 'Iniciar sesion';
  const SubmitIcon =
    mode === 'signup' ? UserPlus : mode === 'forgot' || mode === 'update' ? KeyRound : LogIn;

  const modal =
    isOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 grid place-items-center bg-slate-950/85 p-4 backdrop-blur-md sm:p-8"
            style={{ zIndex: AUTH_OVERLAY_Z_INDEX }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-dialog-title"
          >
            <button
              type="button"
              className="absolute inset-0 cursor-default"
              aria-label="Cerrar"
              onClick={closeModal}
            />
            <div className="relative w-full max-w-2xl overflow-hidden rounded-lg border border-slate-700 bg-slate-950 shadow-2xl shadow-cyan-950/30">
              <div className="flex max-h-[min(760px,calc(100dvh-3rem))] flex-col overflow-y-auto">
                <div className="flex items-start justify-between gap-6 border-b border-slate-800 px-6 py-5 sm:px-8">
                  <div>
                    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
                      <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <h2 id="auth-dialog-title" className="text-2xl font-semibold text-slate-100">
                      {modalTitles[mode]}
                    </h2>
                    <p className="mt-2 text-sm text-slate-400">{modalSubtitles[mode]}</p>
                  </div>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-400 transition hover:border-slate-500 hover:text-slate-100"
                    aria-label="Cerrar"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="px-6 py-6 sm:px-8">
                  {mode !== 'update' && (
                    <div className="mb-6 grid grid-cols-3 rounded-md border border-slate-800 bg-slate-900/60 p-1">
                      <button
                        type="button"
                        onClick={() => openModal('login')}
                        className={`flex h-11 items-center justify-center gap-2 rounded text-sm transition ${
                          mode === 'login'
                            ? 'bg-cyan-400/15 text-cyan-100'
                            : 'text-slate-500 hover:text-slate-200'
                        }`}
                      >
                        <LogIn className="h-4 w-4" aria-hidden="true" />
                        <span>Login</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openModal('signup')}
                        className={`flex h-11 items-center justify-center gap-2 rounded text-sm transition ${
                          mode === 'signup'
                            ? 'bg-cyan-400/15 text-cyan-100'
                            : 'text-slate-500 hover:text-slate-200'
                        }`}
                      >
                        <UserPlus className="h-4 w-4" aria-hidden="true" />
                        <span>Registro</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openModal('forgot')}
                        className={`flex h-11 items-center justify-center gap-2 rounded text-sm transition ${
                          mode === 'forgot'
                            ? 'bg-cyan-400/15 text-cyan-100'
                            : 'text-slate-500 hover:text-slate-200'
                        }`}
                      >
                        <KeyRound className="h-4 w-4" aria-hidden="true" />
                        <span>Recuperar</span>
                      </button>
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="space-y-5">
                    {shouldShowEmail && (
                      <label className="block">
                        <span className="mb-2 block text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                          Email
                        </span>
                        <input
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          required
                          autoComplete="email"
                          className="h-12 w-full rounded-md border border-slate-700 bg-slate-900 px-4 text-base text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-400"
                          placeholder="tu@email.com"
                        />
                      </label>
                    )}

                    {shouldShowPassword && (
                      <div className="block">
                        <label
                          htmlFor="auth-password"
                          className="mb-2 block text-xs font-medium uppercase tracking-[0.16em] text-slate-500"
                        >
                          Contrasena
                        </label>
                        <div className="relative">
                          <input
                            id="auth-password"
                            type={isPasswordVisible ? 'text' : 'password'}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                            minLength={6}
                            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                            className="h-12 w-full rounded-md border border-slate-700 bg-slate-900 px-4 pr-14 text-base text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-400"
                            placeholder="Minimo 6 caracteres"
                          />
                          <button
                            type="button"
                            onClick={() => setIsPasswordVisible((currentValue) => !currentValue)}
                            aria-label={isPasswordVisible ? 'Ocultar contrasena' : 'Mostrar contrasena'}
                            aria-pressed={isPasswordVisible}
                            className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-cyan-100"
                          >
                            {isPasswordVisible ? (
                              <EyeOff className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Eye className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    {error && (
                      <div className="rounded-md border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                        {error}
                      </div>
                    )}

                    {message && (
                      <div className="flex items-start gap-3 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
                        <MailCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" aria-hidden="true" />
                        <span>{message}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-cyan-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                    >
                      <SubmitIcon className="h-4 w-4" aria-hidden="true" />
                      <span>{submitLabel}</span>
                    </button>

                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => openModal('forgot')}
                        className="h-10 w-full text-sm text-slate-400 transition hover:text-cyan-100"
                      >
                        He olvidado la contrasena
                      </button>
                    )}

                    {mode === 'signup' && message && (
                      <button
                        type="button"
                        onClick={handleResendVerification}
                        disabled={isSubmitting}
                        className="h-10 w-full rounded-md border border-slate-700 text-sm text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:text-slate-600"
                      >
                        Reenviar verificacion
                      </button>
                    )}
                  </form>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {user ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsProfileMenuOpen((currentValue) => !currentValue)}
            className="flex h-11 items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15"
            aria-label="Abrir perfil"
            aria-expanded={isProfileMenuOpen}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-300 text-sm font-bold text-slate-950">
              {getUserInitial(user.email)}
            </span>
            <UserCircle className="h-4 w-4" aria-hidden="true" />
          </button>

          {isProfileMenuOpen && (
            <div
              className="absolute right-0 top-full mt-3 max-h-[min(560px,calc(100dvh-6rem))] w-80 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-4 shadow-2xl shadow-cyan-950/30"
              style={{ zIndex: AUTH_OVERLAY_Z_INDEX }}
            >
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-lg font-bold text-cyan-100">
                  {getUserInitial(user.email)}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-100">Perfil</div>
                  <div className="truncate text-xs text-slate-400" title={user.email ?? undefined}>
                    {user.email ?? 'Usuario autenticado'}
                  </div>
                </div>
              </div>

              <div className="mb-4 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
                Sesion activa
              </div>

              <div className="grid gap-2">
                {user.cargo === 'admin' && (
                  <a
                    href="/playground"
                    onClick={() => {
                      setIsProfileMenuOpen(false);
                    }}
                    className="flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15"
                  >
                    <FlaskConical className="h-4 w-4" aria-hidden="true" />
                    <span>Playground</span>
                  </a>
                )}
                {user.cargo === 'admin' && (
                  <a
                    href="/console"
                    onClick={() => {
                      setIsProfileMenuOpen(false);
                    }}
                    className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    <Gauge className="h-4 w-4" aria-hidden="true" />
                    <span>Internal Console</span>
                  </a>
                )}
                {user.cargo === 'admin' && (
                  <a
                    href="/new-version"
                    onClick={() => {
                      setIsProfileMenuOpen(false);
                    }}
                    className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    <span>New Version</span>
                  </a>
                )}
                {user.cargo === 'admin' && (
                  <a
                    href="/new-version-claude"
                    onClick={() => {
                      setIsProfileMenuOpen(false);
                    }}
                    className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    <Bot className="h-4 w-4" aria-hidden="true" />
                    <span>New Version Claude</span>
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => openModal('update')}
                  className="flex h-10 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100"
                >
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  <span>Cambiar contrasena</span>
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="flex h-10 items-center gap-2 rounded-md border border-red-400/30 bg-red-500/10 px-3 text-sm text-red-100 transition hover:border-red-300/60"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  <span>Cerrar sesion</span>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => openModal('login')}
          className="flex h-10 items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 text-sm font-medium text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          <span>Entrar</span>
        </button>
      )}
      {modal}
    </>
  );
}

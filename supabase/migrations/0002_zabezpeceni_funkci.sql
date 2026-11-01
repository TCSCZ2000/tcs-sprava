alter function public.touch() set search_path = public;
alter function public.can_read(text) set search_path = public;
alter function public.can_write(text) set search_path = public;
-- rls_auto_enable vytváří Supabase při zapnutí automatického RLS
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

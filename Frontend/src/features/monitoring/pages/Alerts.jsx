import { useCallback, useEffect, useState } from 'react';
import {
  RiNotification3Line,
  RiAddLine,
  RiRefreshLine,
  RiDeleteBinLine,
} from '@remixicon/react';
import {
  getChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  testChannel,
  getNotificationLogs,
} from '../services/channel.api';
import Notification from '../../../components/Notification';

const TYPES = ['Email', 'Slack', 'Webhook', 'SMS'];
// Delivered by POSTing to the target, so the API only accepts a public URL.
const URL_TYPES = ['Slack', 'Webhook'];

const timeAgo = (date) => {
  if (!date) return '—';
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

const Alerts = () => {
  const [channels, setChannels] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ type: 'Email', target: '' });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [chRes, logRes] = await Promise.allSettled([
        getChannels(),
        getNotificationLogs(),
      ]);
      if (chRes.status === 'fulfilled') setChannels(chRes.value?.data || []);
      if (logRes.status === 'fulfilled') setLogs(logRes.value?.data || []);
      if (chRes.status === 'rejected') {
        setNotification({ message: 'Failed to load channels', type: 'error' });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = async (ch) => {
    const next = !ch.active;
    setChannels((list) =>
      list.map((c) => (c._id === ch._id ? { ...c, active: next } : c))
    );
    try {
      await updateChannel(ch._id, { active: next });
    } catch (err) {
      setChannels((list) =>
        list.map((c) => (c._id === ch._id ? { ...c, active: ch.active } : c))
      );
      setNotification({
        message: err.response?.data?.message || 'Failed to update channel',
        type: 'error',
      });
    }
  };

  const onAdd = async (e) => {
    e.preventDefault();
    if (!form.target.trim()) {
      setNotification({ message: 'Target is required', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      await createChannel({ type: form.type, target: form.target.trim() });
      setForm({ type: 'Email', target: '' });
      setShowAdd(false);
      setNotification({ message: 'Channel added', type: 'success' });
      load();
    } catch (err) {
      setNotification({
        message: err.response?.data?.message || 'Failed to add channel',
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (ch) => {
    if (!window.confirm(`Remove ${ch.type} channel "${ch.target}"?`)) return;
    setBusyId(ch._id);
    try {
      await deleteChannel(ch._id);
      setChannels((list) => list.filter((c) => c._id !== ch._id));
      setNotification({ message: 'Channel removed', type: 'success' });
    } catch (err) {
      setNotification({
        message: err.response?.data?.message || 'Failed to remove channel',
        type: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  const onTest = async (ch) => {
    setBusyId(ch._id);
    try {
      const res = await testChannel(ch._id);
      setNotification({
        message: res?.message || 'Test dispatch sent',
        type: 'success',
      });
      load();
    } catch (err) {
      setNotification({
        message: err.response?.data?.message || 'Test dispatch failed',
        type: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-12 luxury-container">
      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-6 mb-12">
        <div>
          <h1 className="luxury-heading text-3xl md:text-4xl">Alert Center</h1>
          <p className="luxury-subtext mt-3 max-w-md">
            Configure notification dispatch channels and monitor transmission
            history.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={load}
            disabled={loading}
            className="luxury-button-outline flex items-center gap-2"
          >
            <RiRefreshLine
              className={`w-5 h-5 ${loading ? 'animate-spin text-[#cc785c]' : ''}`}
            />
            Refresh
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="luxury-button-primary flex items-center gap-3 px-8"
          >
            <RiAddLine className="w-5 h-5" /> Add Channel
          </button>
        </div>
      </div>

      {loading && channels.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[#cc785c]" />
        </div>
      ) : channels.length === 0 ? (
        <div className="border border-dashed border-[#e6dfd8] rounded-2xl py-20 text-center mb-16">
          <p className="luxury-subtext mb-6">
            No dispatch channels yet. Incident emails still go to your account
            address.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="luxury-button-primary px-8"
          >
            Add your first channel
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8 mb-16">
          {channels.map((ch) => (
            <div
              key={ch._id}
              className="luxury-card group hover:border-[#cc785c]/30 transition-all duration-300"
            >
              <div className="flex justify-between items-start mb-8">
                <div className="w-12 h-12 bg-[#faf9f5] border border-[#e6dfd8] rounded-2xl flex items-center justify-center text-[#cc785c]">
                  <RiNotification3Line className="w-6 h-6" />
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={!!ch.active}
                    onChange={() => onToggle(ch)}
                  />
                  <div className="w-10 h-5 bg-[#e6dfd8] rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#cc785c]"></div>
                </label>
              </div>
              <h3 className="luxury-heading text-2xl mb-2">{ch.type}</h3>
              <p className="text-sm text-[#6c6a64] font-mono mb-2 break-all">
                {ch.target}
              </p>
              <p className="text-xs text-[#6c6a64] mb-8">
                {ch.active ? 'Active' : 'Paused'}
              </p>
              <div className="flex gap-4 pt-6 border-t border-[#e6dfd8]">
                <button
                  onClick={() => onTest(ch)}
                  disabled={busyId === ch._id}
                  className="text-xs font-semibold text-[#a8543a] hover:underline disabled:opacity-50"
                >
                  {busyId === ch._id ? 'Working…' : 'Test Dispatch'}
                </button>
                <button
                  onClick={() => onDelete(ch)}
                  disabled={busyId === ch._id}
                  className="text-xs font-semibold text-[#6c6a64] hover:text-red-600 flex items-center gap-1 disabled:opacity-50"
                >
                  <RiDeleteBinLine className="w-3.5 h-3.5" /> Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white border border-[#e6dfd8] rounded-2xl shadow-sm p-6 md:p-10 overflow-hidden">
        <h2 className="luxury-heading text-2xl mb-8">Transmission Log</h2>
        <div className="overflow-x-auto">
          {logs.length === 0 ? (
            <div className="min-h-[200px] flex items-center justify-center text-center">
              <p className="luxury-subtext">
                No dispatches yet. Alerts appear here once an incident fires or
                you send a test dispatch.
              </p>
            </div>
          ) : (
            <table className="luxury-table">
              <thead>
                <tr>
                  <th>Event Type</th>
                  <th>Channel</th>
                  <th>Recipient</th>
                  <th>Timestamp</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr
                    key={log._id}
                    className="group hover:bg-[#faf9f5] transition-colors"
                  >
                    <td>
                      <span className="text-sm font-semibold text-[#141413] font-mono">
                        {log.event}
                      </span>
                      {log.monitorId?.title && (
                        <p className="text-xs text-[#6c6a64] mt-1">
                          {log.monitorId.title}
                        </p>
                      )}
                    </td>
                    <td className="text-sm text-[#3d3d3a]">{log.channel}</td>
                    <td className="text-sm text-[#6c6a64] break-all">
                      {log.target || '—'}
                    </td>
                    <td className="text-sm text-[#6c6a64]">
                      {timeAgo(log.createdAt)}
                    </td>
                    <td>
                      <span
                        className={`luxury-badge ${
                          log.status === 'Delivered'
                            ? 'bg-[#cc785c]/10 text-[#cc785c]'
                            : log.status === 'Failed'
                              ? 'bg-red-50 text-red-600'
                              : 'bg-[#e6dfd8]/40 text-[#6c6a64]'
                        }`}
                        title={log.detail || ''}
                      >
                        {log.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowAdd(false)}
        >
          <div
            className="w-full max-w-md bg-white border border-[#e6dfd8] rounded-2xl p-8 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="luxury-heading text-2xl mb-8">
              Add dispatch channel
            </h3>
            <form onSubmit={onAdd} className="space-y-6">
              <div>
                <label className="luxury-label" htmlFor="ch-type">
                  Type
                </label>
                <select
                  id="ch-type"
                  value={form.type}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, type: e.target.value }))
                  }
                  className="w-full mt-2 p-3 bg-[#faf9f5] border border-[#e6dfd8] rounded-xl text-[#141413]"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="luxury-label" htmlFor="ch-target">
                  {form.type === 'Email' ? 'Email address' : 'Target'}
                </label>
                <input
                  id="ch-target"
                  value={form.target}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, target: e.target.value }))
                  }
                  placeholder={
                    form.type === 'Email'
                      ? 'alerts@example.com'
                      : URL_TYPES.includes(form.type)
                        ? 'https://hooks.example.com/watchtower'
                        : '#ops-alerts'
                  }
                  className="w-full mt-2 p-3 bg-[#faf9f5] border border-[#e6dfd8] rounded-xl text-[#141413]"
                />
                {form.type !== 'Email' && (
                  <p className="text-xs text-[#6c6a64] mt-2">
                    Only Email delivery is configured on this deployment; other
                    types are stored and logged as skipped.
                  </p>
                )}
              </div>
              <div className="flex gap-4 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="luxury-button-primary px-8 disabled:opacity-60"
                >
                  {saving ? 'Adding…' : 'Add channel'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="luxury-button-outline px-8"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Alerts;

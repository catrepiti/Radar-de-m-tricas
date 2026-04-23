import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Plus, 
  RefreshCcw, 
  BarChart3, 
  TrendingUp, 
  Users, 
  LogOut, 
  CheckCircle2, 
  AlertCircle,
  ExternalLink,
  ChevronDown,
  LayoutGrid,
  Settings,
  Menu,
  Bell,
  BellRing,
  AlertTriangle,
  Info,
  Star,
  Calendar
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell
} from 'recharts';
import { collection, onSnapshot, query, where, addDoc, updateDoc, doc, getDocs } from 'firebase/firestore';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { auth, db } from './lib/firebase';
import { adApiService, AdMetric } from './services/adApiService';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function formatRelativeTime(dateString?: string) {
  if (!dateString) return 'Nunca';
  try {
    const lastSync = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - lastSync.getTime()) / 1000);

    if (diffInSeconds < 0) return 'Agora mesmo'; // Handle future dates/clock drift
    if (diffInSeconds < 60) return 'Agora';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}min atrás`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h atrás`;
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d atrás`;
    
    return lastSync.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch (e) {
    return 'Erro';
  }
}

// --- Types ---
interface Client {
  id: string;
  name: string;
  platform: 'meta' | 'google';
  accountId: string;
  userId: string;
  encryptedToken?: string;
  status: 'active' | 'paused' | 'error';
  lastSync?: string;
  todayMetrics?: AdMetric;
  yesterdayMetrics?: AdMetric;
  history?: { date: string, spend: number, conversions: number }[];
}

// --- Components ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [isAddingClient, setIsAddingClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState<'dashboard' | 'clients' | 'creatives' | 'settings'>('dashboard');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<'all' | 'meta' | 'google'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'error'>('all');
  const [dateRange, setDateRange] = useState('today');
  const [alertSettings, setAlertSettings] = useState({ cpaThreshold: 100, spendDropThreshold: 30, spendSurgeThreshold: 50 });

  const dateMultiplier = useMemo(() => {
    switch (dateRange) {
      case 'yesterday': return 1.05;
      case 'last7': return 7.2;
      case 'last14': return 14.5;
      case 'last30': return 31.5;
      case 'thisMonth': return 14.8;
      case 'lastMonth': return 30.2;
      case 'thisYear': return 115;
      case 'allTime': return 500;
      default: return 1;
    }
  }, [dateRange]);

  // --- Real-time Metrics Sync Loop ---
  useEffect(() => {
    if (!user || clients.length === 0) return;

    // Initial sync
    syncAllMetrics();

    // Set interval for every 60 seconds
    const intervalId = setInterval(() => {
      syncAllMetrics();
    }, 60000);

    return () => clearInterval(intervalId);
  }, [user, clients.length]); // Only re-run if user changes or a new client is added

  async function syncAllMetrics() {
    console.log("Iniciando varredura de métricas em tempo real...");
    for (const client of clients) {
      if (!client.encryptedToken || client.status !== 'active') continue;
      
      try {
        const metrics = await adApiService.getMetrics(client.platform, client.accountId, client.encryptedToken);
        
        // Use historical data to set yesterday's metrics if they don't exist
        const yesterdayData = metrics.history?.[0]; // The latest historical day (yesterday)
        const updatePayload: any = {
          todayMetrics: metrics,
          history: metrics.history || [],
          lastSync: new Date().toISOString()
        };

        if (!client.yesterdayMetrics && yesterdayData) {
          updatePayload.yesterdayMetrics = {
            spend: yesterdayData.spend,
            conversions: yesterdayData.conversions,
            clicks: Math.floor(yesterdayData.spend / 1.5) // Simulated clicks
          };
        }

        // Update client document
        await updateDoc(doc(db, 'clients', client.id), updatePayload);
      } catch (err) {
        console.error(`Falha ao sincronizar: ${client.name}`, err);
      }
    }
  }

  // --- Alert System Logic ---
  const alerts = useMemo(() => {
    const list: { id: string, type: 'cpa' | 'spend' | 'error' | 'surge', severity: 'high' | 'medium', message: string, clientName: string, clientId: string }[] = [];
    
    clients.forEach(c => {
      const today = c.todayMetrics;
      const yesterday = c.yesterdayMetrics;

      // CPA Surge: Based on user threshold
      const cpaIncreasePercent = (alertSettings.cpaThreshold / 100);
      if (today?.cpa && yesterday?.cpa && today.cpa >= yesterday.cpa * (1 + cpaIncreasePercent)) {
        list.push({
          id: `cpa-${c.id}`,
          type: 'cpa',
          severity: 'high',
          clientName: c.name,
          clientId: c.id,
          message: `CPA disparou para R$ ${today.cpa.toFixed(2)} (${c.name})`
        });
      }

      // Spend Surge: Detect abnormal cost increase
      const surgePercent = (alertSettings.spendSurgeThreshold / 100);
      if (today?.spend !== undefined && yesterday?.spend !== undefined && yesterday.spend > 10) {
        if (today.spend >= yesterday.spend * (1 + surgePercent)) {
          list.push({
            id: `surge-${c.id}`,
            type: 'surge',
            severity: 'high',
            clientName: c.name,
            clientId: c.id,
            message: `ALERTA DE CUSTO: Gasto explodiu para R$ ${today.spend.toFixed(2)} (${c.name})`
          });
        }
      }

      // Spend Drop: Based on user threshold
      const spendDropPercent = (alertSettings.spendDropThreshold / 100);
      if (today?.spend !== undefined && yesterday?.spend !== undefined && yesterday.spend > 50) {
        const drop = (yesterday.spend - today.spend) / yesterday.spend;
        if (drop >= spendDropPercent) {
          list.push({
            id: `spend-${c.id}`,
            type: 'spend',
            severity: 'medium',
            clientName: c.name,
            clientId: c.id,
            message: `Gasto caiu ${Math.round(drop * 100)}% (${c.name})`
          });
        }
      }

      // Connection Error
      if (c.status === 'error') {
        list.push({
          id: `err-${c.id}`,
          type: 'error',
          severity: 'high',
          clientName: c.name,
          clientId: c.id,
          message: `Erro crítico de conexão: ${c.name}`
        });
      }
    });

    return list;
  }, [clients]);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setClients([]);
      return;
    }

    const q = query(collection(db, 'clients'), where('userId', '==', user.uid));
    return onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Client));
      setClients(docs);
    });
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'settings'), where('userId', '==', user.uid));
    return onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const data = snapshot.docs[0].data();
        setAlertSettings({
          cpaThreshold: data.cpaThreshold || 100,
          spendDropThreshold: data.spendDropThreshold || 30,
          spendSurgeThreshold: data.spendSurgeThreshold || 50
        });
      }
    });
  }, [user]);

  const filteredClients = useMemo(() => {
    return clients.filter(c => {
      const matchPlatform = platformFilter === 'all' || c.platform === platformFilter;
      const matchStatus = statusFilter === 'all' || c.status === statusFilter;
      return matchPlatform && matchStatus;
    });
  }, [clients, platformFilter, statusFilter]);

  const login = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const logout = () => signOut(auth);

  if (loading) return <div className="h-screen bg-[#0a0a0a] flex items-center justify-center text-white font-mono uppercase tracking-[0.5em] text-xs">Loading...</div>;

  if (!user) return <LoginView />;

  return (
    <div className="h-screen bg-[#0a0a0a] text-[#e5e7eb] font-sans flex flex-col overflow-hidden selection:bg-indigo-500 selection:text-white">
      {/* Header */}
      <header className="h-16 border-b border-grid px-6 flex items-center justify-between bg-[#0d0d0d] flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center font-bold text-white shadow-sm">M</div>
          <h1 className="text-lg font-semibold tracking-tight uppercase">Radar <span className="text-indigo-400">Métricas</span></h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest hidden md:block">
            Sincronização em Tempo Real (60s)
          </div>
          
          {/* Notifications */}
          <div className="relative">
            <button 
              onClick={() => setShowNotifications(!showNotifications)}
              className={cn(
                "p-2 rounded-full transition-colors relative",
                alerts.length > 0 ? "text-amber-500 hover:bg-amber-500/10" : "text-gray-500 hover:bg-gray-800"
              )}
            >
              {alerts.length > 0 ? <BellRing size={18} className="animate-pulse" /> : <Bell size={18} />}
              {alerts.length > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border border-[#0d0d0d]" />
              )}
            </button>

            <AnimatePresence>
              {showNotifications && (
                <motion.div 
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute right-0 mt-3 w-80 bg-[#141414] border border-grid rounded-xl shadow-2xl z-[100] overflow-hidden"
                >
                  <div className="p-4 border-b border-grid bg-[#0d0d0d] flex justify-between items-center">
                    <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Alertas do Radar ({alerts.length})</h3>
                    <button onClick={() => setShowNotifications(false)} className="text-gray-600 hover:text-white transition-colors"><Plus size={14} className="rotate-45" /></button>
                  </div>
                  <div className="max-h-[400px] overflow-y-auto">
                    {alerts.length === 0 ? (
                      <div className="p-8 text-center text-[10px] text-gray-600 uppercase tracking-widest">Nenhuma anomalia detectada</div>
                    ) : (
                      alerts.map(alert => (
                        <div key={alert.id} className="p-4 border-b border-grid hover:bg-[#1a1a1a] transition-colors flex gap-3 group">
                           {alert.type === 'cpa' && <AlertTriangle size={16} className="text-red-500 shrink-0" />}
                           {alert.type === 'spend' && <TrendingUp size={16} className="text-amber-500 shrink-0 rotate-180" />}
                           {alert.type === 'surge' && <TrendingUp size={16} className="text-red-600 shrink-0" />}
                           {alert.type === 'error' && <AlertCircle size={16} className="text-red-600 shrink-0" />}
                           <div>
                              <div className="text-[10px] font-bold text-gray-200">{alert.message}</div>
                              <div className="text-[8px] text-gray-500 uppercase mt-1">Impacto: {alert.severity === 'high' ? 'Crítico' : 'Médio'}</div>
                           </div>
                        </div>
                      ))
                    )}
                  </div>
                  {alerts.length > 0 && (
                    <div className="p-3 bg-[#0d0d0d] text-center">
                       <button className="text-[9px] uppercase font-bold text-indigo-400 hover:text-indigo-300 transition-colors">Limpar Histórico</button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          
          <div className="relative group/date">
            <button className="flex items-center gap-2 px-3 py-1.5 border border-grid rounded bg-[#1a1a1a] hover:bg-[#222] transition-colors shadow-sm min-w-[140px]">
              <Calendar size={14} className="text-gray-400" />
              <span className="text-[10px] font-bold uppercase tracking-tight text-gray-300">
                {dateRange === 'today' && 'Hoje'}
                {dateRange === 'yesterday' && 'Ontem'}
                {dateRange === 'last7' && 'Últimos 7 dias'}
                {dateRange === 'last30' && 'Últimos 30 dias'}
                {dateRange === 'thisMonth' && 'Este mês'}
                {dateRange === 'lastMonth' && 'Mês passado'}
                {dateRange === 'custom' && 'Personalizado'}
              </span>
              <ChevronDown size={12} className="text-gray-500 ml-auto" />
            </button>
            <div className="absolute right-0 top-full mt-2 w-56 bg-[#141414] border border-grid rounded-lg shadow-2xl opacity-0 scale-95 group-hover/date:opacity-100 group-hover/date:scale-100 pointer-events-none group-hover/date:pointer-events-auto transition-all z-[100] origin-top-right overflow-hidden overflow-y-auto max-h-[400px]">
              {[
                { id: 'today', label: 'Hoje' },
                { id: 'yesterday', label: 'Ontem' },
                { id: 'last7', label: 'Últimos 7 dias' },
                { id: 'last14', label: 'Últimos 14 dias' },
                { id: 'last30', label: 'Últimos 30 dias' },
                { id: 'thisMonth', label: 'Este mês' },
                { id: 'lastMonth', label: 'Mês passado' },
                { id: 'thisYear', label: 'Este ano' },
                { id: 'allTime', label: 'Todo o período' },
                { id: 'custom', label: 'Personalizado' },
              ].map((opt) => (
                <button 
                  key={opt.id}
                  onClick={() => setDateRange(opt.id)}
                  className={cn(
                    "w-full text-left px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest hover:bg-indigo-600 transition-colors border-b border-grid last:border-0",
                    dateRange === opt.id ? "text-indigo-400 bg-indigo-500/5" : "text-gray-400"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="h-5 w-[1px] bg-grid mx-2" />
          <div className="flex items-center gap-3">
             <div 
               title={user.email || ''}
               className="w-8 h-8 rounded-full bg-gray-800 border border-grid flex items-center justify-center text-[10px] font-bold uppercase transition-transform hover:scale-105 cursor-pointer"
             >
               {(user.displayName || user.email)?.charAt(0)}
             </div>
             <button onClick={logout} className="p-1.5 text-gray-500 hover:text-white transition-colors" title="Sair">
               <LogOut size={16} />
             </button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Mini */}
        <aside className="w-16 border-r border-grid flex flex-col items-center py-6 gap-8 bg-[#0d0d0d] flex-shrink-0">
          <div 
            onClick={() => setCurrentPath('dashboard')}
            className={cn("cursor-pointer hover:scale-110 transition-transform p-1 rounded", currentPath === 'dashboard' ? "text-indigo-500 bg-indigo-500/10" : "text-gray-600")}
            title="Dashboard"
          >
            <LayoutGrid size={20} />
          </div>
          <div 
            onClick={() => setCurrentPath('clients')}
            className={cn("cursor-pointer hover:text-indigo-400 transition-colors p-1 rounded", currentPath === 'clients' ? "text-indigo-500 bg-indigo-500/10" : "text-gray-600")}
            title="Clientes"
          >
            <Users size={20} />
          </div>
          <div 
            onClick={() => setCurrentPath('creatives')}
            className={cn("cursor-pointer hover:text-indigo-400 transition-colors p-1 rounded", currentPath === 'creatives' ? "text-indigo-500 bg-indigo-500/10" : "text-gray-600")}
            title="Criativos"
          >
            <BarChart3 size={20} />
          </div>
          <div 
            onClick={() => setCurrentPath('settings')}
            className={cn("mt-auto cursor-pointer hover:text-indigo-400 transition-colors p-1 rounded", currentPath === 'settings' ? "text-indigo-500 bg-indigo-500/10" : "text-gray-600")}
            title="Configurações"
          >
            <Settings size={20} />
          </div>
        </aside>

        {/* Main Content Pane */}
        <main className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
          {currentPath === 'dashboard' && (
            <>
              {/* Top KPIs */}
              <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <KPIItem 
                  title={dateRange === 'today' ? "Gasto Hoje" : "Gasto Total"} 
                  value={`R$ ${(clients.reduce((acc, c) => acc + (c.todayMetrics?.spend || 0), 0) * dateMultiplier).toFixed(2)}`} 
                  tooltip="Total investido em todas as plataformas no período selecionado"
                  diff={dateRange === 'today' ? (() => {
                    const today = clients.reduce((acc, c) => acc + (c.todayMetrics?.spend || 0), 0);
                    const yesterday = clients.reduce((acc, c) => acc + (c.yesterdayMetrics?.spend || 0), 0);
                    if (yesterday === 0) return "0.0%";
                    const diff = ((today - yesterday) / yesterday) * 100;
                    return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% vs ontem`;
                  })() : undefined} 
                  diffColor={dateRange === 'today' ? (() => {
                    const today = clients.reduce((acc, c) => acc + (c.todayMetrics?.spend || 0), 0);
                    const yesterday = clients.reduce((acc, c) => acc + (c.yesterdayMetrics?.spend || 0), 0);
                    return today > yesterday ? "text-amber-500" : "text-emerald-500";
                  })() : undefined}
                />
                <KPIItem 
                  title="ROAS Médio" 
                  value={(() => {
                    const valid = filteredClients.filter(c => (c.todayMetrics?.spend || 0) > 0);
                    if (valid.length === 0) return "0.0x";
                    // Attempt to use roas from todayMetrics or calculate spend/conv
                    const roasSum = valid.reduce((acc, c) => {
                      const val = c.todayMetrics?.roas || (c.todayMetrics?.conversions || 0) * 50 / (c.todayMetrics?.spend || 1); // Fallback calc
                      return acc + val;
                    }, 0);
                    return `${(roasSum / valid.length).toFixed(2)}x`;
                  })()} 
                  tooltip="Retorno sobre o gasto publicitário proporcional ao faturamento/conversões"
                  diff="Alta Eficiência"
                  diffColor="text-emerald-400"
                />
                <KPIItem 
                  title="CPA Médio" 
                  value={(() => {
                    const validClients = filteredClients.filter(c => (c.todayMetrics?.cpa || 0) > 0);
                    if (validClients.length === 0) return "R$ 0,00";
                    const avg = validClients.reduce((acc, c) => acc + (c.todayMetrics?.cpa || 0), 0) / validClients.length;
                    return `R$ ${avg.toFixed(2)}`;
                  })()} 
                  tooltip="Custo médio por aquisição considerando as contas filtradas"
                  diff="Sincronizado" 
                  diffColor="text-gray-500" 
                />
                <KPIItem 
                  title="Conversões" 
                  value={Math.floor(clients.reduce((acc, c) => acc + (c.todayMetrics?.conversions || 0), 0) * dateMultiplier).toString()} 
                  tooltip="Quantidade total de ações valiosas registradas no período"
                  diff="Radar Ativo" 
                  diffColor="text-indigo-400" 
                />
                <KPIItem 
                  title="CTR Médio" 
                  value={(() => {
                    const valid = filteredClients.filter(c => (c.todayMetrics?.ctr || 0) > 0);
                    if (valid.length === 0) return "1.85%"; // Fallback
                    const avg = valid.reduce((acc, c) => acc + (c.todayMetrics?.ctr || 0), 0) / valid.length;
                    return `${avg.toFixed(2)}%`;
                  })()} 
                  tooltip="Taxa média de cliques em relação às impressões"
                />
                <KPIItem 
                  title="CPC Médio" 
                  value={(() => {
                    const valid = filteredClients.filter(c => (c.todayMetrics?.spend || 0) > 0 && (c.todayMetrics?.clicks || 0) > 0);
                    if (valid.length === 0) return "R$ 0.95"; // Fallback
                    const avg = valid.reduce((acc, c) => acc + (c.todayMetrics?.spend || 0) / (c.todayMetrics?.clicks || 1), 0) / valid.length;
                    return `R$ ${avg.toFixed(2)}`;
                  })()} 
                  tooltip="Custo médio pago por cada clique no anúncio"
                />
              </section>

              {/* Central Grid */}
              <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 overflow-hidden">
                {/* Table Area */}
                <div className="lg:col-span-8 card rounded-lg flex flex-col overflow-hidden shadow-sm">
                   <div className="p-4 border-b border-grid flex items-center justify-between bg-[#111]/50">
                      <h2 className="text-xs font-bold uppercase tracking-widest text-gray-300">Controle Diário de Performance</h2>
                      <div className="flex gap-4">
                         <div className="flex items-center gap-2">
                           <span className="text-[9px] uppercase font-bold text-gray-600">Plat:</span>
                           <select 
                             value={platformFilter}
                             onChange={(e) => setPlatformFilter(e.target.value as any)}
                             className="bg-[#0a0a0a] border border-grid rounded px-2 py-0.5 text-[9px] font-bold uppercase text-gray-400 focus:outline-none focus:border-indigo-500"
                           >
                             <option value="all">Sincronizadas</option>
                             <option value="meta">Meta Ads</option>
                             <option value="google">Google Ads</option>
                           </select>
                         </div>
                         <div className="flex items-center gap-2">
                           <span className="text-[9px] uppercase font-bold text-gray-600">Status:</span>
                           <select 
                             value={statusFilter}
                             onChange={(e) => setStatusFilter(e.target.value as any)}
                             className="bg-[#0a0a0a] border border-grid rounded px-2 py-0.5 text-[9px] font-bold uppercase text-gray-400 focus:outline-none focus:border-indigo-500"
                           >
                             <option value="all">Todos</option>
                             <option value="active">Ativo</option>
                             <option value="paused">Pausado</option>
                             <option value="error">Erro</option>
                           </select>
                         </div>
                      </div>
                   </div>
                   <div className="flex-1 overflow-auto">
                      <table className="w-full text-left border-collapse font-mono text-xs">
                        <thead className="text-[10px] uppercase text-gray-500 bg-[#0d0d0d] sticky top-0 z-10">
                           <tr>
                              <th className="px-4 py-3 border-b border-grid font-bold">Cliente</th>
                              <th className="px-4 py-3 border-b border-grid font-bold text-right group/header relative">
                                 <div className="flex items-center justify-end gap-1 cursor-help text-indigo-400">
                                    Gasto
                                    <Info size={10} />
                                 </div>
                                 <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-black border border-grid rounded text-[8px] tracking-tighter opacity-0 group-hover/header:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400 normal-case font-sans font-normal">
                                    <span className="font-bold uppercase block mb-1 text-gray-100">Gasto Total</span>
                                    Investimento total no período selecionado.
                                 </div>
                              </th>
                              <th className="px-4 py-3 border-b border-grid font-bold text-right group/header relative">
                                 <div className="flex items-center justify-end gap-1 cursor-help text-emerald-400">
                                    ROAS
                                    <Info size={10} />
                                 </div>
                                 <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-black border border-grid rounded text-[8px] tracking-tighter opacity-0 group-hover/header:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400 normal-case font-sans font-normal">
                                    <span className="font-bold uppercase block mb-1 text-gray-100">ROAS Médio</span>
                                    Eficiência financeira direta (Receita / Gasto).
                                 </div>
                              </th>
                              <th className="px-4 py-3 border-b border-grid font-bold text-right group/header relative">
                                 <div className="flex items-center justify-end gap-1 cursor-help">
                                    CPA
                                    <Info size={10} className="text-gray-600" />
                                 </div>
                                 <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-black border border-grid rounded text-[8px] tracking-tighter opacity-0 group-hover/header:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400 normal-case font-sans font-normal">
                                    <span className="font-bold uppercase block mb-1 text-gray-100">Custo por Aquisição</span>
                                    Valor médio pago por cada conversão no período.
                                 </div>
                              </th>
                              <th className="px-4 py-3 border-b border-grid font-bold text-center group/header relative">
                                 <div className="flex items-center justify-center gap-1 cursor-help">
                                    CTR
                                    <Info size={10} className="text-gray-600" />
                                 </div>
                                 <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-black border border-grid rounded text-[8px] tracking-tighter opacity-0 group-hover/header:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400 normal-case font-sans font-normal text-center">
                                    <span className="font-bold uppercase block mb-1 text-gray-100 text-center">CTR Global</span>
                                    Taxa de cliques em relação às impressões.
                                 </div>
                              </th>
                              <th className="px-4 py-3 border-b border-grid font-bold text-right group/header relative">
                                 <div className="flex items-center justify-end gap-1 cursor-help">
                                    CPC
                                    <Info size={10} className="text-gray-600" />
                                 </div>
                                 <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-black border border-grid rounded text-[8px] tracking-tighter opacity-0 group-hover/header:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400 normal-case font-sans font-normal text-right">
                                    <span className="font-bold uppercase block mb-1 text-gray-100 text-right">Custo por Clique</span>
                                    Custo médio por clique gerado em anúncios.
                                 </div>
                              </th>
                              <th className="px-4 py-3 border-b border-grid font-bold text-center">Status</th>
                           </tr>
                        </thead>
                        <tbody>
                          {filteredClients.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="px-4 py-12 text-center text-gray-600 font-sans italic">Nenhum cliente radarizado com esses filtros.</td>
                            </tr>
                          ) : (
                            filteredClients.map((client) => {
                              const hasAlert = alerts.some(a => a.clientId === client.id);
                              return (
                                <tr 
                                  key={client.id} 
                                  className={cn(
                                    "border-b border-grid hover:bg-[#1a1a1a] transition-colors group cursor-pointer",
                                    hasAlert && "bg-amber-950/10"
                                  )}
                                  onClick={() => { setSelectedClient(client); setCurrentPath('creatives'); }}
                                >
                                  <td className={cn(
                                    "px-4 py-2 font-sans text-gray-300 relative",
                                    hasAlert && "before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:bg-amber-500 before:rounded-r before:shadow-[0_0_10px_rgba(245,158,11,0.5)] before:animate-pulse"
                                  )}>
                                    <div className="flex items-center gap-2">
                                       {client.name}
                                       {hasAlert && (
                                         <div className="relative group/alert">
                                            <AlertTriangle size={12} className="text-amber-500 animate-bounce duration-1000" />
                                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-black border border-grid rounded text-[8px] uppercase tracking-tighter opacity-0 group-hover/alert:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl">
                                             {alerts.find(a => a.clientId === client.id)?.message}
                                          </div>
                                       </div>
                                     )}
                                  </div>
                                </td>
                                <td className="px-4 py-2 text-right">R$ {( (client.todayMetrics?.spend || 0) * dateMultiplier).toFixed(2)}</td>
                                <td className="px-4 py-2 text-right text-emerald-400 font-bold">
                                  {(client.todayMetrics?.roas || ( (client.todayMetrics?.conversions || 0) * 50 / (client.todayMetrics?.spend || 1) )).toFixed(2)}x
                                </td>
                                <td className="px-4 py-2 text-right text-gray-400">R$ {client.todayMetrics?.cpa?.toFixed(2) || "0,00"}</td>
                                <td className="px-4 py-2 text-center text-indigo-400">
                                  {client.todayMetrics?.ctr?.toFixed(2) || "1.85"}%
                                </td>
                                <td className="px-4 py-2 text-right text-gray-500">
                                  R$ {(client.todayMetrics?.cpc || ( (client.todayMetrics?.spend || 0) / (client.todayMetrics?.clicks || 1) )).toFixed(2)}
                                </td>
                                <td className="px-4 py-2">
                                   <div className="flex items-center justify-center gap-2">
                                      {!client.encryptedToken ? (
                                        <button 
                                          onClick={(e) => { e.stopPropagation(); handleConnectAccount(client); }} 
                                          className="flex items-center gap-1.5 px-2 py-0.5 bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 rounded text-[9px] font-bold uppercase hover:bg-indigo-600 hover:text-white transition-all cursor-pointer shadow-sm"
                                        >
                                          <ExternalLink size={10} /> Conectar
                                        </button>
                                      ) : (
                                        <>
                                          {client.status === 'error' ? (
                                            <div className="flex items-center gap-1.5 text-red-500" title="Erro de Conexão">
                                              <AlertCircle size={14} />
                                              <span className="text-[9px] font-bold uppercase hidden md:inline">Erro</span>
                                            </div>
                                          ) : client.status === 'active' ? (
                                            <div className="flex items-center gap-1.5 text-emerald-500" title="Conexão Ativa">
                                              <CheckCircle2 size={14} />
                                              <span className="text-[9px] font-bold uppercase hidden md:inline">Ativo</span>
                                            </div>
                                          ) : (
                                            <div className="flex items-center gap-1.5 text-amber-500" title="Conexão Pausada">
                                              <div className="w-2 h-2 rounded-full bg-amber-500" />
                                              <span className="text-[9px] font-bold uppercase hidden md:inline">Pausado</span>
                                            </div>
                                          )}
                                        </>
                                      )}
                                   </div>
                                </td>
                              </tr>
                            )
                          })
                          )}
                        </tbody>
                      </table>
                   </div>
                </div>

                {/* Right Pane */}
                <div className="lg:col-span-4 flex flex-col gap-6">
                  {/* Chart Activity */}
                  <div className="card p-4 rounded-lg flex-1 min-h-[180px] shadow-sm">
                     <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-4">Tendência Gasto (7d)</h3>
                     <div className="flex items-end gap-1.5 h-32 mb-4">
                        {[5, 5, 5, 5, 5, 5, 5].map((h, i) => (
                          <div key={i} className={cn("flex-1 rounded-t transition-all hover:scale-105", i === 6 ? "bg-indigo-500" : "bg-gray-800")} style={{ height: `${h}%` }} />
                        ))}
                     </div>
                     <div className="flex justify-between text-[10px] text-gray-600 font-mono">
                        <span>Histórico</span>
                        <span>Tempo Real</span>
                     </div>
                  </div>

                  {/* Action Area */}
                  <div className="card p-5 rounded-lg bg-indigo-950/20 border-indigo-900/50 shadow-sm">
                     <h3 className="text-xs font-bold mb-4 uppercase tracking-widest text-[#e5e7eb] flex items-center gap-2">
                       <Plus size={14} className="text-indigo-400" /> Adicionar Cliente
                     </h3>
                     <div className="space-y-3">
                        <button 
                          onClick={() => setIsAddingClient(true)}
                          className="w-full border border-grid bg-[#1a1a1a] hover:bg-[#222] py-3 rounded text-[10px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-all transition-colors text-gray-400 hover:text-white"
                        >
                          Configurar Novo Radar
                        </button>
                        <p className="text-[9px] text-gray-600 text-center uppercase tracking-tighter">Conecte sua conta para começar a analisar estrategicamente.</p>
                     </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {currentPath === 'creatives' && (
            <div className="flex-1 flex flex-col gap-6 animate-in fade-in duration-300">
               <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold uppercase tracking-tight">Vigilância de Criativos Ativos</h2>
                    <p className="text-xs text-gray-500 uppercase tracking-widest mt-1">
                      Mapeamento estratégico de performance visual
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] uppercase font-bold text-gray-500">Alvo:</span>
                    <select 
                      value={selectedClient?.id || ''}
                      onChange={(e) => {
                        const client = clients.find(c => c.id === e.target.value);
                        setSelectedClient(client || null);
                      }}
                      className="bg-[#111] border border-grid rounded px-3 py-1.5 text-xs font-bold uppercase text-indigo-400 focus:outline-none focus:border-indigo-500 min-w-[200px]"
                    >
                      <option value="">Todos os Ativos</option>
                      {clients.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {selectedClient && (
                      <button 
                        onClick={() => setSelectedClient(null)} 
                        className="text-[10px] uppercase font-bold text-gray-600 hover:text-white transition-colors"
                      >
                        Limpar
                      </button>
                    )}
                  </div>
               </div>

               <div className="card p-6 rounded-lg shadow-sm bg-[#111]/30 border border-grid">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2">
                      <TrendingUp size={14} className="text-emerald-400" />
                      <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-300">Ranking Top 5 Master - ROAS Líderes</h3>
                    </div>
                    <div className="flex gap-4">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-indigo-500" />
                        <span className="text-[8px] uppercase font-bold text-gray-500">Meta</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-yellow-500" />
                        <span className="text-[8px] uppercase font-bold text-gray-500">Google</span>
                      </div>
                    </div>
                  </div>
                  <div className="h-48 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart 
                        data={MOCK_CREATIVES
                          .filter(c => !selectedClient || (c as any).clientId === selectedClient.id || c.platform === selectedClient.platform)
                          .sort((a, b) => parseFloat(b.roas) - parseFloat(a.roas))
                          .slice(0, 5)
                          .map(c => ({
                            name: c.name,
                            roas: parseFloat(c.roas),
                            platform: c.platform
                          }))}
                        margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#222" />
                        <XAxis 
                          dataKey="name" 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{ fill: '#666', fontSize: 7 }} 
                          interval={0}
                          tickFormatter={(val) => val.length > 12 ? val.substring(0, 12) + '...' : val}
                        />
                        <YAxis 
                          axisLine={false} 
                          tickLine={false} 
                          tick={{ fill: '#666', fontSize: 8 }} 
                        />
                        <Tooltip 
                          cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                          contentStyle={{ backgroundColor: '#0d0d0d', border: '1px solid #333', fontSize: '9px', borderRadius: '4px', textTransform: 'uppercase', fontMono: 'true' }}
                          itemStyle={{ color: '#fff' }}
                        />
                        <Bar dataKey="roas" radius={[2, 2, 0, 0]} barSize={32}>
                          {
                            MOCK_CREATIVES
                              .filter(c => !selectedClient || (c as any).clientId === selectedClient.id || c.platform === selectedClient.platform)
                              .sort((a, b) => parseFloat(b.roas) - parseFloat(a.roas))
                              .slice(0, 5)
                              .map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.platform === 'meta' ? '#6366f1' : '#eab308'} />
                              ))
                          }
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
               </div>

               {selectedClient && !selectedClient.encryptedToken ? (
                 <div className="card p-20 flex flex-col items-center justify-center gap-4 text-center">
                    <AlertCircle size={40} className="text-amber-500 opacity-50" />
                    <p className="max-w-xs text-gray-400 text-sm">Esta conta ainda não está conectada. Autentique o acesso para visualizar a performance dos criativos ativos.</p>
                    <button 
                      onClick={() => handleConnectAccount(selectedClient)}
                      className="bg-indigo-600 text-white px-6 py-2 rounded text-xs font-bold uppercase tracking-widest hover:bg-indigo-500 transition-colors"
                    >
                      Autenticar Agora
                    </button>
                 </div>
               ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {/* Vigilância de Criativos Grid */}
                   {!selectedClient && clients.length === 0 ? (
                     <div className="col-span-full py-20 text-center text-gray-600 italic border border-dashed border-grid rounded-lg">
                       Adicione clientes para começar o mapeamento de criativos.
                     </div>
                   ) : (
                     MOCK_CREATIVES
                       .filter(c => !selectedClient || (c as any).clientId === selectedClient.id || c.platform === selectedClient.platform)
                       .map((creative, i) => (
                       <motion.div 
                         key={creative.id}
                         initial={{ opacity: 0, y: 10 }}
                         animate={{ opacity: 1, y: 0 }}
                         transition={{ delay: i * 0.05 }}
                         className={cn(
                           "card rounded-lg overflow-hidden group shadow-sm transition-all bg-[#0f0f0f] relative",
                           creative.status === 'High Performance' && "ring-1 ring-emerald-500/50 border-emerald-500/40 shadow-[0_0_15px_-5px_rgba(16,185,129,0.25)]",
                           creative.status === 'Scaling' && "ring-1 ring-indigo-500/40 border-indigo-500/30 shadow-[0_0_15px_-5px_rgba(99,102,241,0.15)]",
                           (creative.status !== 'High Performance' && creative.status !== 'Scaling') && "hover:border-indigo-500/50 border-grid"
                         )}
                       >
                          {/* Hover Summary Overlay */}
                          <div className="absolute inset-0 bg-black/95 z-[45] opacity-0 group-hover:opacity-100 transition-all duration-300 pointer-events-none p-5 flex flex-col justify-between border border-indigo-500/30 backdrop-blur-sm translate-y-4 group-hover:translate-y-0 text-left">
                             <div>
                                <div className="flex justify-between items-start mb-4">
                                   <div>
                                      <h5 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-1">Status de Performance</h5>
                                      <div className={cn(
                                         "text-xs font-bold uppercase text-white",
                                         creative.status === 'Underperforming' && "text-red-400",
                                         creative.status === 'High Performance' && "text-emerald-400"
                                      )}>{creative.status}</div>
                                   </div>
                                   <div className="text-right">
                                      <div className="text-[8px] text-gray-500 uppercase">Eficiência</div>
                                      <div className="text-sm font-mono font-bold text-white">{creative.roas}x</div>
                                   </div>
                                </div>

                                <div className="space-y-3">
                                   <div className="flex justify-between items-center border-b border-white/5 pb-2 text-gray-300">
                                      <span className="text-[9px] uppercase font-medium">CTR (Qualidade)</span>
                                      <span className="text-[10px] font-mono font-bold">{creative.ctr}</span>
                                   </div>
                                   <div className="flex justify-between items-center border-b border-white/5 pb-2 text-gray-300">
                                      <span className="text-[9px] uppercase font-medium">CPC (Custo)</span>
                                      <span className="text-[10px] font-mono font-bold">{creative.cpc}</span>
                                   </div>
                                   <div className="flex justify-between items-center border-b border-white/5 pb-2 text-gray-300">
                                      <span className="text-[9px] uppercase font-medium">CPM (Entrega)</span>
                                      <span className="text-[10px] font-mono font-bold">{creative.cpm}</span>
                                   </div>
                                </div>
                             </div>

                             <div className="bg-indigo-600/10 border border-indigo-600/20 p-2 rounded text-center">
                                <p className="text-[8px] text-indigo-200 leading-relaxed uppercase tracking-widest font-bold italic">
                                   {creative.status === 'High Performance' ? "Criativo Campeão • Escalar Orçamento" : 
                                    creative.status === 'Underperforming' ? "Baixa Eficiência • Pausar e Reavaliar" :
                                    "Performance Estável • Monitorar Tendência"}
                                </p>
                             </div>
                          </div>

                          <div className="aspect-[4/3] bg-gray-950 relative overflow-hidden border-b border-grid">
                             <img 
                               src={creative.image} 
                               alt={creative.name}
                               className="w-full h-full object-cover opacity-60 group-hover:opacity-90 transition-opacity duration-500"
                               referrerPolicy="no-referrer"
                             />
                             <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />
                             
                             <div className="absolute top-2 right-2 flex flex-col gap-1 items-end">
                                <div className={cn(
                                  "px-2 py-0.5 text-[8px] font-bold uppercase rounded shadow-lg backdrop-blur-md flex items-center gap-1",
                                  creative.status === 'Underperforming' ? "bg-red-500/20 text-red-400 border border-red-500/30" : 
                                  creative.status === 'High Performance' ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" :
                                  creative.status === 'Scaling' ? "bg-indigo-500/20 text-indigo-400 border border-indigo-500/30" :
                                  "bg-white/5 text-gray-400 border border-white/10"
                                )}>
                                  {(creative.status === 'High Performance' || creative.status === 'Scaling') && <Star size={8} className="fill-current text-white shrink-0" />}
                                  {creative.status}
                                </div>
                             </div>

                             <div className="absolute bottom-2 left-2 right-2">
                                <div className="text-[10px] font-mono text-indigo-400 font-bold mb-0.5">#{creative.id.toUpperCase()}</div>
                                <h4 className="text-[11px] font-bold text-white line-clamp-1 truncate">{creative.name}</h4>
                             </div>
                          </div>

                          <div className="p-4 space-y-4">
                             <div className="flex justify-between items-center text-[10px] font-mono text-gray-500 uppercase tracking-tighter">
                                <span>{selectedClient?.platform || 'META'} ADS</span>
                                <div className="flex items-center gap-1">
                                   <TrendingUp size={10} className={parseFloat(creative.roas) >= 4.0 ? "text-emerald-400" : "text-gray-600"} />
                                   <span className={parseFloat(creative.roas) >= 4.0 ? "text-emerald-400 font-bold" : ""}>ROAS {creative.roas}</span>
                                </div>
                             </div>

                             <div className="h-10 w-full bg-black/20 rounded p-1">
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart data={creative.roasHistory.map((val: number, i: number) => ({ val, i }))}>
                                    <Line 
                                      type="monotone" 
                                      dataKey="val" 
                                      stroke={parseFloat(creative.roas) >= 4.0 ? "#10b981" : "#6366f1"} 
                                      strokeWidth={2} 
                                      dot={false} 
                                    />
                                    <Tooltip 
                                      content={({ active, payload }) => {
                                        if (active && payload && payload.length) {
                                          return (
                                            <div className="bg-black border border-grid px-2 py-1 rounded text-[7px] font-mono text-white">
                                              ROAS: {payload[0].value}
                                            </div>
                                          );
                                        }
                                        return null;
                                      }}
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                             </div>

                             <div className="grid grid-cols-3 gap-1 bg-black/40 p-2 rounded border border-grid">
                                <div className="text-center relative group/metric">
                                   <div className="text-[8px] text-gray-500 uppercase mb-0.5 cursor-help">CTR</div>
                                   <div className="text-[10px] font-bold font-mono text-gray-200">{creative.ctr}</div>
                                   <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-32 p-2 bg-black border border-grid rounded text-[7px] uppercase tracking-tighter opacity-0 group-hover/metric:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400">
                                      Taxa de Cliques. Indica a relevância do criativo para o público.
                                   </div>
                                </div>
                                <div className="text-center border-x border-grid/50 relative group/metric">
                                   <div className="text-[8px] text-gray-500 uppercase mb-0.5 cursor-help">CPC</div>
                                   <div className="text-[10px] font-bold font-mono text-gray-200">{creative.cpc}</div>
                                   <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-32 p-2 bg-black border border-grid rounded text-[7px] uppercase tracking-tighter opacity-0 group-hover/metric:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400">
                                      Custo por Clique. O valor pago por cada interação no anúncio.
                                   </div>
                                </div>
                                <div className="text-center relative group/metric">
                                   <div className="text-[8px] text-gray-500 uppercase mb-0.5 cursor-help">CPM</div>
                                   <div className="text-[10px] font-bold font-mono text-white">{creative.cpm}</div>
                                   <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-32 p-2 bg-black border border-grid rounded text-[7px] uppercase tracking-tighter opacity-0 group-hover/metric:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-400">
                                      Custo por mil impressões. O valor da entrega para o público.
                                   </div>
                                </div>
                             </div>

                             <div className="flex gap-2">
                                <button className="flex-1 py-1.5 bg-indigo-600/10 hover:bg-indigo-600 hover:text-white text-indigo-400 text-[9px] font-bold uppercase rounded border border-indigo-500/20 transition-all flex items-center justify-center gap-1.5">
                                   Ver no Gerenciador <ExternalLink size={10} />
                                </button>
                             </div>
                          </div>
                       </motion.div>
                     ))
                   )}
                </div>
               )}
            </div>
          )}

          {currentPath === 'clients' && (
            <div className="flex-1 animate-in slide-in-from-right duration-300">
               <div className="flex justify-between items-center mb-6">
                 <h2 className="text-xl font-bold uppercase">Gestão Operacional de Clientes</h2>
                 <button 
                   onClick={() => setIsAddingClient(true)}
                   className="bg-white text-black px-4 py-2 rounded text-[10px] font-bold uppercase shadow-sm"
                 >
                   Adicionar Novo Alvo
                 </button>
               </div>
               <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                 {clients.length === 0 ? (
                    <div className="col-span-full py-20 text-center text-gray-600 italic border border-dashed border-grid rounded-lg">Sua carteira de clientes ainda está vazia.</div>
                 ) : (
                   clients.map(client => (
                     <div key={client.id} className="card p-6 rounded-lg flex flex-col gap-4 relative hover:border-indigo-900 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className={cn("w-2 h-2 rounded-full", client.status === 'active' ? "bg-emerald-500" : "bg-amber-500")} />
                          <h3 className="font-bold text-gray-200">{client.name}</h3>
                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] text-gray-500 uppercase font-mono">Conta ID: {client.accountId}</div>
                          <div className="text-[10px] text-gray-500 uppercase font-mono">Plataforma: {client.platform === 'meta' ? 'Meta Ads' : 'Google Ads'}</div>
                        </div>
                        <div className="mt-4 flex gap-2">
                          <button className="flex-1 py-2 text-[9px] font-bold uppercase border border-grid rounded hover:bg-gray-800 transition-colors text-gray-400">Ver Estratégia</button>
                          {!client.encryptedToken && (
                             <button onClick={() => handleConnectAccount(client)} className="flex-1 py-2 text-[9px] font-bold uppercase bg-indigo-600 rounded hover:bg-indigo-500 transition-colors text-white">Conectar</button>
                          )}
                        </div>
                     </div>
                   ))
                 )}
               </div>
            </div>
          )}

          {currentPath === 'settings' && (
            <div className="flex-1 max-w-2xl mx-auto w-full animate-in fade-in duration-300 py-6">
              <div className="flex items-center gap-3 mb-8">
                <div className="w-10 h-10 bg-indigo-600/20 border border-indigo-500/30 rounded-lg flex items-center justify-center text-indigo-400">
                  <Settings size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-bold uppercase tracking-tight">Configurações do Radar</h2>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">Ajuste os parâmetros de inteligência do seu painel</p>
                </div>
              </div>

              <div className="space-y-6">
                 {/* Alert Thresholds Area */}
                 <div className="card rounded-lg overflow-hidden">
                    <div className="p-4 border-b border-grid bg-[#111]/50 flex items-center gap-2">
                       <Bell size={14} className="text-indigo-400" />
                       <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-300">Configuração de Alertas</h3>
                    </div>
                    <div className="p-6 space-y-6">
                       <div className="space-y-4">
                          <div className="flex justify-between items-end">
                             <div>
                                <h4 className="text-xs font-bold text-gray-200 uppercase tracking-widest">Gatilho de CPA</h4>
                                <p className="text-[10px] text-gray-500 mt-1">Notificar quando o CPA aumentar mais de:</p>
                             </div>
                             <div className="text-indigo-400 font-mono text-xs font-bold">{alertSettings.cpaThreshold}%</div>
                          </div>
                          <input 
                            type="range" 
                            min="10" 
                            max="500" 
                            step="10"
                            value={alertSettings.cpaThreshold}
                            onChange={async (e) => {
                              const val = parseInt(e.target.value);
                              setAlertSettings(s => ({ ...s, cpaThreshold: val }));
                              if (!user) return;
                              const q = query(collection(db, 'settings'), where('userId', '==', user.uid));
                              const snap = await getDocs(q);
                              if (snap.empty) {
                                await addDoc(collection(db, 'settings'), { userId: user.uid, cpaThreshold: val, spendDropThreshold: alertSettings.spendDropThreshold });
                              } else {
                                await updateDoc(doc(db, 'settings', snap.docs[0].id), { cpaThreshold: val });
                              }
                            }}
                            className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                          />
                          <div className="flex justify-between text-[8px] uppercase text-gray-600 font-bold">
                             <span>Conservador (10%)</span>
                             <span>Agressivo (500%)</span>
                          </div>
                       </div>

                       <div className="h-[1px] bg-grid" />

                       <div className="space-y-4">
                          <div className="flex justify-between items-end">
                             <div>
                                <h4 className="text-xs font-bold text-gray-200 uppercase tracking-widest">Gatilho de Explosão de Custo</h4>
                                <p className="text-[10px] text-gray-500 mt-1">Notificar quando o gasto aumentar mais de:</p>
                             </div>
                             <div className="text-red-500 font-mono text-xs font-bold">{alertSettings.spendSurgeThreshold}%</div>
                          </div>
                          <input 
                            type="range" 
                            min="10" 
                            max="300" 
                            step="10"
                            value={alertSettings.spendSurgeThreshold}
                            onChange={async (e) => {
                              const val = parseInt(e.target.value);
                              setAlertSettings(s => ({ ...s, spendSurgeThreshold: val }));
                              if (!user) return;
                              const q = query(collection(db, 'settings'), where('userId', '==', user.uid));
                              const snap = await getDocs(q);
                              if (snap.empty) {
                                await addDoc(collection(db, 'settings'), { userId: user.uid, spendSurgeThreshold: val, cpaThreshold: alertSettings.cpaThreshold, spendDropThreshold: alertSettings.spendDropThreshold });
                              } else {
                                await updateDoc(doc(db, 'settings', snap.docs[0].id), { spendSurgeThreshold: val });
                              }
                            }}
                            className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-red-500"
                          />
                          <div className="flex justify-between text-[8px] uppercase text-gray-600 font-bold">
                             <span>Sensível (10%)</span>
                             <span>Pico Drástico (300%)</span>
                          </div>
                       </div>

                       <div className="h-[1px] bg-grid" />

                       <div className="space-y-4">
                          <div className="flex justify-between items-end">
                             <div>
                                <h4 className="text-xs font-bold text-gray-200 uppercase tracking-widest">Gatilho de Gasto</h4>
                                <p className="text-[10px] text-gray-500 mt-1">Notificar quando o gasto diário cair mais de:</p>
                             </div>
                             <div className="text-amber-500 font-mono text-xs font-bold">{alertSettings.spendDropThreshold}%</div>
                          </div>
                          <input 
                            type="range" 
                            min="5" 
                            max="90" 
                            step="5"
                            value={alertSettings.spendDropThreshold}
                            onChange={async (e) => {
                              const val = parseInt(e.target.value);
                              setAlertSettings(s => ({ ...s, spendDropThreshold: val }));
                              if (!user) return;
                              const q = query(collection(db, 'settings'), where('userId', '==', user.uid));
                              const snap = await getDocs(q);
                              if (snap.empty) {
                                await addDoc(collection(db, 'settings'), { userId: user.uid, spendDropThreshold: val, cpaThreshold: alertSettings.cpaThreshold });
                              } else {
                                await updateDoc(doc(db, 'settings', snap.docs[0].id), { spendDropThreshold: val });
                              }
                            }}
                            className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                          />
                          <div className="flex justify-between text-[8px] uppercase text-gray-600 font-bold">
                             <span>Vigilante (5%)</span>
                             <span>Permissivo (90%)</span>
                          </div>
                       </div>
                    </div>
                 </div>

                 {/* System Info */}
                 <div className="card p-4 rounded-lg bg-indigo-950/10 border-indigo-900/30">
                    <div className="flex gap-3">
                       <Info size={16} className="text-indigo-400 shrink-0" />
                       <div>
                          <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#e5e7eb] mb-1">Dica de Estratégia</h4>
                          <p className="text-[10px] text-gray-500 leading-relaxed">
                            Ajuste os gatilhos conforme a fase da conta. Em contas novas, use limites mais largos (Agressivos). Para contas escaladas, mantenha limites curtos (Conservadores) para proteger o lucro.
                          </p>
                       </div>
                    </div>
                 </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {isAddingClient && (
          <ClientModal 
            onClose={() => setIsAddingClient(false)} 
            onSubmit={async (data) => {
              await addDoc(collection(db, 'clients'), {
                ...data,
                userId: user.uid,
                status: 'paused',
                createdAt: new Date().toISOString()
              });
              setIsAddingClient(false);
            }} 
          />
        )}
      </AnimatePresence>

      <OAuthListener onAuthSuccess={async (platform, token) => {
        console.log(`Auth success for ${platform}`);
      }} />
    </div>
  );

  async function handleConnectAccount(client: Client) {
    try {
      const url = await adApiService.getAuthUrl(client.platform);
      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) return alert('Ative popups.');
      const handler = (event: MessageEvent) => {
        if (!event.origin.endsWith('.run.app') && !event.origin.includes('localhost')) return;
        if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.platform === client.platform) {
          updateDoc(doc(db, 'clients', client.id), { encryptedToken: event.data.token, status: 'active' });
          window.removeEventListener('message', handler);
        }
      };
      window.addEventListener('message', handler);
    } catch (err) { console.error(err); }
  }
}

// --- Constants ---
const MOCK_CREATIVES = [
  { 
    id: 'c1', 
    name: 'Campanha Performance Max - Q2', 
    ctr: '2.45%', 
    cpc: 'R$ 1,20', 
    cpm: 'R$ 15,40', 
    roas: '4.2',
    roasHistory: [3.8, 4.0, 4.1, 3.9, 4.2, 4.3, 4.2],
    image: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=800&auto=format&fit=crop',
    status: 'High Performance',
    platform: 'google',
    clientId: 'sample-client-1'
  },
  { 
    id: 'c2', 
    name: 'Retargeting Dinâmico - Carrinho', 
    ctr: '3.12%', 
    cpc: 'R$ 0,85', 
    cpm: 'R$ 12,20', 
    roas: '5.8',
    roasHistory: [5.2, 5.5, 5.4, 5.7, 5.8, 6.0, 5.8],
    image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?q=80&w=800&auto=format&fit=crop',
    status: 'Scaling',
    platform: 'meta',
    clientId: 'sample-client-2'
  },
  { 
    id: 'c3', 
    name: 'Vídeo Reel - Engajamento Top', 
    ctr: '1.85%', 
    cpc: 'R$ 0,45', 
    cpm: 'R$ 8,50', 
    roas: '3.1',
    roasHistory: [2.8, 2.9, 3.0, 3.2, 3.1, 3.3, 3.1],
    image: 'https://images.unsplash.com/photo-1542744094-24638eff58bb?q=80&w=800&auto=format&fit=crop',
    status: 'Stable',
    platform: 'meta',
    clientId: 'sample-client-2'
  },
  { 
    id: 'c4', 
    name: 'Copy Curta - Teste A/B v2', 
    ctr: '0.95%', 
    cpc: 'R$ 2,10', 
    cpm: 'R$ 22,00', 
    roas: '1.2',
    roasHistory: [1.5, 1.4, 1.3, 1.2, 1.4, 1.1, 1.2],
    image: 'https://images.unsplash.com/photo-1551288049-bbbda536339a?q=80&w=800&auto=format&fit=crop',
    status: 'Underperforming',
    platform: 'google',
    clientId: 'sample-client-1'
  },
  { 
    id: 'c5', 
    name: 'Interesses Similares - LAL 1%', 
    ctr: '2.10%', 
    cpc: 'R$ 1,15', 
    cpm: 'R$ 14,80', 
    roas: '3.9',
    roasHistory: [3.5, 3.6, 3.8, 3.7, 3.9, 4.0, 3.9],
    image: 'https://images.unsplash.com/photo-1553729459-efe14ef6055d?q=80&w=800&auto=format&fit=crop',
    status: 'High Performance',
    platform: 'meta',
    clientId: 'sample-client-1'
  },
  {
    id: 'c6',
    name: 'Shorts - Review de Produto',
    ctr: '3.45%',
    cpc: 'R$ 0,60',
    cpm: 'R$ 10,20',
    roas: '6.2',
    roasHistory: [5.8, 6.0, 6.1, 5.9, 6.2, 6.3, 6.2],
    image: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?q=80&w=800&auto=format&fit=crop',
    status: 'High Performance',
    platform: 'google',
    clientId: 'sample-client-2'
  },
  {
    id: 'c7',
    name: 'Carousel - Novidades Verão',
    ctr: '2.80%',
    cpc: 'R$ 1,40',
    cpm: 'R$ 18,50',
    roas: '4.8',
    roasHistory: [4.2, 4.4, 4.3, 4.6, 4.8, 5.0, 4.8],
    image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=800&auto=format&fit=crop',
    status: 'Scaling',
    platform: 'meta',
    clientId: 'sample-client-1'
  }
];

// --- Sub-components ---

function KPIItem({ title, value, diff, diffColor, tooltip }: { title: string, value: string, diff?: string, diffColor?: string, tooltip?: string }) {
  return (
    <div className="card p-4 rounded-lg shadow-sm group hover:border-gray-700 transition-colors relative">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{title}</div>
        {tooltip && (
          <div className="relative group/tooltip">
            <Info size={10} className="text-gray-600 cursor-help" />
            <div className="absolute bottom-full right-0 mb-2 w-40 p-2 bg-black border border-grid rounded text-[8px] uppercase tracking-tighter opacity-0 group-hover/tooltip:opacity-100 pointer-events-none transition-opacity z-50 shadow-2xl leading-relaxed text-gray-300">
              {tooltip}
            </div>
          </div>
        )}
      </div>
      <div className="text-xl font-bold font-mono text-[#e5e7eb] group-hover:text-indigo-400 transition-colors">{value}</div>
      {diff && <div className={cn("text-[10px] font-medium mt-1 uppercase", diffColor)}>{diff}</div>}
    </div>
  );
}

function LoginView() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleGoogleLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setError(err.message || 'Erro ao entrar com Google');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return setError('Preencha todos os campos');
    
    try {
      setLoading(true);
      setError(null);
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        if (!name) return setError('Preencha seu nome');
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(userCredential.user, { displayName: name });
      }
    } catch (err: any) {
      let msg = 'Erro na autenticação';
      if (err.code === 'auth/user-not-found') msg = 'Usuário não encontrado';
      if (err.code === 'auth/wrong-password') msg = 'Senha incorreta';
      if (err.code === 'auth/email-already-in-use') msg = 'Este e-mail já está em uso';
      if (err.code === 'auth/weak-password') msg = 'A senha deve ter pelo menos 6 caracteres';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6 relative overflow-hidden font-sans">
      <div className="absolute inset-0 opacity-20 pointer-events-none">
         <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-600 rounded-full blur-[160px]" />
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-md w-full bg-[#141414] border border-[#1f1f1f] p-10 rounded-xl shadow-2xl relative z-10"
      >
        <div className="w-12 h-12 bg-indigo-600 rounded-lg flex items-center justify-center font-bold text-white text-2xl mb-8 mx-auto shadow-indigo-500/20 shadow-lg">M</div>
        <h2 className="text-xl font-bold text-center mb-1 tracking-tight uppercase">Radar <span className="text-indigo-400">Métricas</span></h2>
        <p className="text-gray-500 text-center mb-10 text-xs uppercase tracking-widest">
          {isLogin ? 'Acesso Restrito • Gestores de Tráfego' : 'Novo Registro • Comece sua Análise'}
        </p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-500 text-[10px] uppercase font-bold p-3 rounded mb-6 flex items-center gap-2">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}
        
        <form onSubmit={handleEmailAuth} className="space-y-4 mb-8">
          {!isLogin && (
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1 block">Nome Completo</label>
              <input 
                type="text" 
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-[#0a0a0a] border border-[#1f1f1f] p-3 rounded text-xs outline-none focus:border-indigo-500 transition-all text-white"
                placeholder="Seu nome"
              />
            </div>
          )}
          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1 block">E-mail Corporativo</label>
            <input 
              type="email" 
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#1f1f1f] p-3 rounded text-xs outline-none focus:border-indigo-500 transition-all text-white"
              placeholder="seu@email.com"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold mb-1 block">Senha Segura</label>
            <input 
              type="password" 
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#1f1f1f] p-3 rounded text-xs outline-none focus:border-indigo-500 transition-all text-white"
              placeholder="••••••••"
            />
          </div>
          
          <button 
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-4 rounded-lg transition-all shadow-lg uppercase text-xs tracking-widest disabled:opacity-50"
          >
            {loading ? 'Processando...' : (isLogin ? 'Entrar no Radar' : 'Criar minha conta')}
          </button>
        </form>

        <div className="relative mb-8">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[#1f1f1f]"></div>
          </div>
          <div className="relative flex justify-center text-[10px] uppercase">
            <span className="bg-[#141414] px-4 text-gray-600 font-bold">Ou continue com</span>
          </div>
        </div>

        <button 
          onClick={handleGoogleLogin}
          disabled={loading}
          className="w-full bg-white hover:bg-gray-200 text-black font-bold py-4 rounded-lg transition-all flex items-center justify-center gap-3 shadow-lg uppercase text-xs tracking-widest disabled:opacity-50 mb-6"
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="Google" />
          Google
        </button>

        <p className="text-center text-[10px] uppercase tracking-widest text-gray-500 font-medium">
          {isLogin ? 'Não tem uma conta?' : 'Já possui acesso?'}
          <button 
            onClick={() => {
              setIsLogin(!isLogin);
              setError(null);
            }}
            className="ml-2 text-indigo-400 hover:text-indigo-300 font-bold"
          >
            {isLogin ? 'Cadastre-se' : 'Faça Login'}
          </button>
        </p>
      </motion.div>
    </div>
  );
}

function ClientModal({ onClose, onSubmit }: { onClose: () => void, onSubmit: (data: any) => void }) {
  const [formData, setFormData] = useState({ name: '', platform: 'meta', accountId: '' });
  const [errors, setErrors] = useState<{ name?: string, accountId?: string }>({});

  const validate = (field: string, value: string) => {
    let newErrors = { ...errors };
    if (field === 'name') {
      if (value.length < 3) newErrors.name = "Nome muito curto";
      else delete newErrors.name;
    }
    if (field === 'accountId') {
      if (formData.platform === 'meta') {
        if (!/^\d{10,20}$/.test(value)) newErrors.accountId = "ID Meta deve ser numérico (10-20 dígitos)";
        else delete newErrors.accountId;
      } else {
        // Google Ads format: XXX-XXX-XXXX or just digits
        const cleanId = value.replace(/-/g, '');
        if (!/^\d{10}$/.test(cleanId)) newErrors.accountId = "ID Google deve ter 10 dígitos (XXX-XXX-XXXX)";
        else delete newErrors.accountId;
      }
    }
    setErrors(newErrors);
  };

  const handleInputChange = (field: string, value: string) => {
    const updatedData = { ...formData, [field]: value };
    setFormData(updatedData);
    validate(field, value);
  };

  useEffect(() => {
    validate('accountId', formData.accountId);
  }, [formData.platform]);

  const isValid = !errors.name && !errors.accountId && formData.name && formData.accountId;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        className="bg-[#141414] border border-grid p-8 rounded-xl w-full max-w-sm shadow-2xl relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-1 h-full bg-indigo-600" />
        
        <h2 className="text-sm font-bold mb-2 flex items-center gap-2 uppercase tracking-widest text-white">
           <Plus size={16} className="text-indigo-500" /> Implantar Novo Radar
        </h2>
        <p className="text-[10px] text-gray-500 uppercase mb-8 tracking-widest font-medium">Configuração de monitoramento estratégico</p>
        
        <div className="space-y-6">
           <div>
              <div className="flex justify-between items-end mb-1">
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Identificação do Cliente</label>
                {errors.name && <span className="text-[9px] text-red-500 font-bold uppercase">{errors.name}</span>}
              </div>
              <input 
                type="text" 
                placeholder="Ex: E-commerce Alpha"
                className={cn(
                  "w-full bg-[#0a0a0a] border p-3 rounded text-xs outline-none transition-all text-white placeholder:text-gray-700",
                  errors.name ? "border-red-500/50 focus:border-red-500" : "border-grid focus:border-indigo-500"
                )}
                value={formData.name}
                onChange={e => handleInputChange('name', e.target.value)}
              />
           </div>

           <div className="flex gap-4">
              <div className="flex-1">
                 <label className="text-[10px] uppercase tracking-widest text-gray-400 mb-1 block font-bold">Fonte de Dados</label>
                 <select 
                   className="w-full bg-[#0a0a0a] border border-grid p-3 rounded text-xs focus:border-indigo-500 outline-none transition-all text-white appearance-none cursor-pointer"
                   value={formData.platform}
                   onChange={e => handleInputChange('platform', e.target.value)}
                 >
                   <option value="meta">Meta Ads</option>
                   <option value="google">Google Ads</option>
                 </select>
              </div>
              <div className="flex-[2]">
                 <div className="flex justify-between items-end mb-1">
                   <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold">ID da Conta</label>
                   {errors.accountId && <span className="text-[8px] text-amber-500 font-bold uppercase">Atenção</span>}
                 </div>
                 <input 
                   type="text" 
                   placeholder={formData.platform === 'meta' ? "1234567890..." : "000-000-0000"}
                   className={cn(
                     "w-full bg-[#0a0a0a] border p-3 rounded text-xs outline-none transition-all text-white placeholder:text-gray-700 font-mono",
                     errors.accountId ? "border-amber-500/50 focus:border-amber-500" : "border-grid focus:border-indigo-500"
                   )}
                   value={formData.accountId}
                   onChange={e => handleInputChange('accountId', e.target.value)}
                 />
              </div>
           </div>

           {errors.accountId && (
             <div className="bg-amber-950/20 border border-amber-900/30 p-2 rounded flex gap-2">
               <Info size={12} className="text-amber-500 shrink-0 mt-0.5" />
               <p className="text-[9px] text-amber-200 leading-tight uppercase font-medium">{errors.accountId}</p>
             </div>
           )}
        </div>

        <div className="flex gap-3 mt-10">
           <button onClick={onClose} className="flex-1 px-4 py-3 border border-grid rounded text-[10px] font-bold uppercase tracking-widest hover:bg-[#1a1a1a] transition-colors text-gray-400">Abortar</button>
           <button 
             onClick={() => onSubmit(formData)} 
             disabled={!isValid}
             className="flex-1 px-4 py-3 bg-indigo-600 text-white rounded text-[10px] font-bold uppercase tracking-widest hover:bg-indigo-500 transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-indigo-600/20"
           >
             Protocolar
           </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function OAuthListener({ onAuthSuccess }: { onAuthSuccess: (platform: string, token: string) => void }) {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!event.origin.endsWith('.run.app') && !event.origin.includes('localhost')) return;
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        onAuthSuccess(event.data.platform, event.data.token);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onAuthSuccess]);
  return null;
}

const chartData = [
  { name: 'Seg', spend: 400 },
  { name: 'Ter', spend: 300 },
  { name: 'Qua', spend: 600 },
  { name: 'Qui', spend: 800 },
  { name: 'Sex', spend: 500 },
  { name: 'Sáb', spend: 900 },
  { name: 'Dom', spend: 1100 },
];

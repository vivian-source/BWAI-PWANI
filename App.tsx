/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { 
  ShieldCheck, 
  Users, 
  TrendingUp, 
  AlertTriangle, 
  Smartphone, 
  CreditCard, 
  History, 
  Grip,
  ChevronRight,
  Info,
  Lock,
  Zap,
  Activity,
  Sprout,
  Calendar,
  Clock,
  PiggyBank
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
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { 
  collection, 
  onSnapshot, 
  query, 
  doc, 
  setDoc, 
  updateDoc, 
  getDocs,
  writeBatch
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged,
  signOut,
  User
} from 'firebase/auth';
import { db, auth, handleFirestoreError, OperationType } from './lib/firebase';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
type MemberStatus = 'Active' | 'Inactive' | 'Suspended';

interface LoanRecord {
  id: string;
  amount: number;
  date: string;
  status: 'Repaid' | 'Ongoing' | 'Defaulted';
  repaymentProgress: number; // 0-100
}

interface RiskAssessment {
  score: number;
  level: 'Low' | 'Medium' | 'High';
  recommendation: 'Approve' | 'Reduce Loan' | 'Reject';
  confidence: number;
  factors: string[];
}

interface ContributionRecord {
  id: string;
  timestamp: string; // ISO format for full precision
  amount: number;
  onTime: boolean;
  method: string;
}

interface Member {
  id: string;
  name: string;
  role: string;
  contact: string;
  joinDate: string; // ISO format
  status: MemberStatus;
  weeklySavings: number; // KES per week (Fixed at 10,000)
  txFreq: number;       // Daily M-Pesa Txs
  avgTxValue: number;   // Average transaction size in KES
  utilityReliability: number; // % of utility bills paid on time (KPLC/Water)
  businessSmsVolume: number; // Average daily SMS business records
  fulizaDep: number;    // 0 to 1
  chamaScore: number;   // 0 to 100
  peerVouches: number;  // count
  stockVelocity: number; // multiplier
  assets: string[];     // Land, cars, etc.
  punctualityScore: number; // 0-100% (Friday 23:59 deadline)
  loanRepaymentHistory: number; // 0-100
  loanHistory: LoanRecord[];
  contributionHistory: ContributionRecord[];
}

// --- Utils ---
const formatDateTime = (isoString: string) => {
  const d = new Date(isoString);
  return {
    date: d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }),
    day: d.toLocaleDateString('en-KE', { weekday: 'long' })
  };
};

const calculateMembershipDuration = (joinDate: string) => {
  const join = new Date(joinDate);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - join.getTime());
  const diffMonths = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 30));
  return diffMonths;
};

const calculateMemberScore = (m: Member) => {
  const mPesaCons = Math.min(100, (m.txFreq * 2.5) + (m.avgTxValue / 500));
  const utilityScore = m.utilityReliability;
  const smsSignal = Math.min(100, m.businessSmsVolume * 5);
  const socialTrust = m.chamaScore;
  const businessHealth = Math.min(100, m.stockVelocity * 30);
  const penalty = m.fulizaDep * 50;
  const assetBonus = m.assets.length * 10;
  
  // Weighted Average for Alternative Credit Scoring
  const baseScore = (
    (mPesaCons * 0.15) + 
    (utilityScore * 0.15) + 
    (smsSignal * 0.10) + 
    (socialTrust * 0.30) + 
    (businessHealth * 0.20) + 
    assetBonus
  );
  
  return Math.max(0, Math.min(100, baseScore - penalty));
};

const calculateInterestRate = (score: number) => {
  if (score >= 90) return 10;
  if (score >= 70) return 15;
  if (score >= 50) return 20;
  return 25;
};

const calculateHybridRiskScore = (m: Member, requestedAmount: number = 50000): RiskAssessment => {
  const latePayments = m.contributionHistory.filter(c => !c.onTime).length;
  const missedContributions = m.status === 'Suspended' ? 5 : 0; // Simplified proxy for demo
  
  // Risk Score Formula: (late payments × 0.4) + (loan amount × 0.2) + (missed contributions × 0.4)
  // Scaling factors to normalize:
  // latePayments (0-10), loanAmount (relative to 250k max), missed (0-10)
  const normalizedLate = Math.min(1, latePayments / 10);
  const normalizedAmount = Math.min(1, requestedAmount / 250000);
  const normalizedMissed = Math.min(1, missedContributions / 10);

  const rawRisk = (normalizedLate * 0.4) + (normalizedAmount * 0.2) + (normalizedMissed * 0.4);
  const score = Math.min(100, rawRisk * 100);

  let level: 'Low' | 'Medium' | 'High' = 'Low';
  let recommendation: 'Approve' | 'Reduce Loan' | 'Reject' = 'Approve';

  if (score > 60) {
    level = 'High';
    recommendation = 'Reject';
  } else if (score > 30) {
    level = 'Medium';
    recommendation = 'Reduce Loan';
  }

  const factors = [];
  if (latePayments > 0) factors.push(`${latePayments} Late Payments Recognized`);
  if (requestedAmount > 100000) factors.push("High Capital Request");
  if (missedContributions > 0) factors.push("Contribution Integrity Weakened");

  return {
    score,
    level,
    recommendation,
    confidence: 0.93,
    factors
  };
};

const getIneligibilityReason = (m: Member) => {
  const reasons = [];
  const months = calculateMembershipDuration(m.joinDate);
  if (months < 6) reasons.push("Seniority < 6mo");
  if (m.punctualityScore < 90) reasons.push("Low Punctuality");
  if (m.assets.length === 0) reasons.push("No Collateral");
  
  const ongoingLoan = m.loanHistory.find(l => l.status === 'Ongoing');
  if (ongoingLoan) reasons.push("Outstanding Loan Present");
  
  if (m.loanRepaymentHistory < 80 && m.loanRepaymentHistory > 0) reasons.push("Poor Debt History");
  return reasons.join(", ");
};

const isLoanEligible = (m: Member) => {
  const months = calculateMembershipDuration(m.joinDate);
  const hasOngoing = m.loanHistory.some(l => l.status === 'Ongoing');
  return (
    months >= 6 &&
    m.punctualityScore >= 90 &&
    m.assets.length > 0 &&
    !hasOngoing &&
    (m.loanRepaymentHistory >= 80 || m.loanRepaymentHistory === 0)
  );
};

const INITIAL_MEMBERS: Member[] = [
  { 
    id: '1', 
    name: 'Otieno', 
    role: 'Chairman (Timber Yard)', 
    contact: '0712 345 678',
    joinDate: '2023-01-15',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 30, 
    avgTxValue: 2500,
    utilityReliability: 95,
    businessSmsVolume: 12,
    fulizaDep: 0.05, 
    chamaScore: 95, 
    peerVouches: 8, 
    stockVelocity: 1.5, 
    assets: ['1/2 Acre Land (Utawala)', 'Dyna Truck'], 
    punctualityScore: 100, 
    loanRepaymentHistory: 95,
    loanHistory: [
      { id: 'l1', amount: 50000, date: '2023-06-10', status: 'Repaid', repaymentProgress: 100 }
    ],
    contributionHistory: [
      { id: 'c1', timestamp: '2024-04-19T10:30:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' },
      { id: 'c0', timestamp: '2024-04-12T09:15:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }
    ]
  },
  { 
    id: '2', 
    name: 'Wanjiku', 
    role: 'Treasurer (Bakery)', 
    contact: '0722 111 222',
    joinDate: '2023-03-20',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 25, 
    avgTxValue: 1800,
    utilityReliability: 100,
    businessSmsVolume: 8,
    fulizaDep: 0.1, 
    chamaScore: 92, 
    peerVouches: 6, 
    stockVelocity: 1.2, 
    assets: ['Retail Shop House (Nyeri)'], 
    punctualityScore: 98, 
    loanRepaymentHistory: 92,
    loanHistory: [],
    contributionHistory: [{ id: 'c2', timestamp: '2024-04-19T14:20:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '3', 
    name: 'Mutua', 
    role: 'Secretary (Hardware)', 
    contact: '0733 444 555',
    joinDate: '2023-08-10',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 20, 
    avgTxValue: 1200,
    utilityReliability: 85,
    businessSmsVolume: 15,
    fulizaDep: 0.15, 
    chamaScore: 88, 
    peerVouches: 5, 
    stockVelocity: 1.1, 
    assets: ['Town House Plot (Machakos)'], 
    punctualityScore: 95, 
    loanRepaymentHistory: 88,
    loanHistory: [{ id: 'l2', amount: 30000, date: '2024-01-05', status: 'Ongoing', repaymentProgress: 60 }],
    contributionHistory: [{ id: 'c3', timestamp: '2024-04-19T16:45:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '6', 
    name: 'Mary', 
    role: 'Member (Mama Mboga)', 
    contact: '0755 999 888',
    joinDate: '2024-01-10',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 12, 
    avgTxValue: 400,
    utilityReliability: 40,
    businessSmsVolume: 2,
    fulizaDep: 0.4, 
    chamaScore: 72, 
    peerVouches: 3, 
    stockVelocity: 1.8, 
    assets: ['Kiosk Stall Entry'], 
    punctualityScore: 85, 
    loanRepaymentHistory: 0,
    loanHistory: [],
    contributionHistory: [{ id: 'c4', timestamp: '2024-04-20T08:10:00Z', amount: 10000, onTime: false, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '4', 
    name: 'Kamau', 
    role: 'Member (Matatu Owner)', 
    contact: '0711 222 333',
    joinDate: '2023-05-12',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 45, 
    avgTxValue: 4500,
    utilityReliability: 100,
    businessSmsVolume: 5,
    fulizaDep: 0.02, 
    chamaScore: 94, 
    peerVouches: 7, 
    stockVelocity: 2.1, 
    assets: ['14-Seater Nissan', 'Logbook Registration'], 
    punctualityScore: 99, 
    loanRepaymentHistory: 96,
    loanHistory: [],
    contributionHistory: [{ id: 'c5', timestamp: '2024-04-19T08:00:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '5', 
    name: 'Adhiambo', 
    role: 'Member (Salonist)', 
    contact: '0744 555 666',
    joinDate: '2023-11-30',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 18, 
    avgTxValue: 1500,
    utilityReliability: 90,
    businessSmsVolume: 4,
    fulizaDep: 0.2, 
    chamaScore: 82, 
    peerVouches: 4, 
    stockVelocity: 1.4, 
    assets: ['Salon Equipment Ledger'], 
    punctualityScore: 92, 
    loanRepaymentHistory: 100,
    loanHistory: [{ id: 'l3', amount: 20000, date: '2024-02-15', status: 'Repaid', repaymentProgress: 100 }],
    contributionHistory: [{ id: 'c6', timestamp: '2024-04-19T11:45:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '7', 
    name: 'Kiprono', 
    role: 'Member (Dairy Farmer)', 
    contact: '0766 777 888',
    joinDate: '2023-02-25',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 15, 
    avgTxValue: 800,
    utilityReliability: 96,
    businessSmsVolume: 3,
    fulizaDep: 0.08, 
    chamaScore: 90, 
    peerVouches: 9, 
    stockVelocity: 1.2, 
    assets: ['5 Friesian Cows', 'Milk Delivery Contract'], 
    punctualityScore: 97, 
    loanRepaymentHistory: 94,
    loanHistory: [],
    contributionHistory: [{ id: 'c7', timestamp: '2024-04-19T07:30:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '8', 
    name: 'Zawadi', 
    role: 'Member (Textile Dealer)', 
    contact: '0777 888 999',
    joinDate: '2024-02-10',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 22, 
    avgTxValue: 3000,
    utilityReliability: 70,
    businessSmsVolume: 10,
    fulizaDep: 0.3, 
    chamaScore: 78, 
    peerVouches: 3, 
    stockVelocity: 2.5, 
    assets: ['Container Goods (Gikomba)'], 
    punctualityScore: 88, 
    loanRepaymentHistory: 0,
    loanHistory: [],
    contributionHistory: [{ id: 'c8', timestamp: '2024-04-19T13:10:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '9', 
    name: 'Onyango', 
    role: 'Member (Fisheries)', 
    contact: '0788 999 000',
    joinDate: '2023-01-05',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 35, 
    avgTxValue: 6000,
    utilityReliability: 100,
    businessSmsVolume: 20,
    fulizaDep: 0.01, 
    chamaScore: 96, 
    peerVouches: 10, 
    stockVelocity: 1.9, 
    assets: ['Motorized Fishing Boat', 'Land Plot (Kisumu)'], 
    punctualityScore: 100, 
    loanRepaymentHistory: 98,
    loanHistory: [{ id: 'l4', amount: 100000, date: '2023-09-20', status: 'Repaid', repaymentProgress: 100 }],
    contributionHistory: [{ id: 'c9', timestamp: '2024-04-19T06:45:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
  { 
    id: '10', 
    name: 'Njeri', 
    role: 'Member (Restaurant Owner)', 
    contact: '0799 000 111',
    joinDate: '2023-09-15',
    status: 'Active',
    weeklySavings: 10000, 
    txFreq: 40, 
    avgTxValue: 3500,
    utilityReliability: 92,
    businessSmsVolume: 18,
    fulizaDep: 0.05, 
    chamaScore: 93, 
    peerVouches: 6, 
    stockVelocity: 3.2, 
    assets: ['Restaurant Lease (CBD)', 'Kitchen Equipment'], 
    punctualityScore: 96, 
    loanRepaymentHistory: 90,
    loanHistory: [],
    contributionHistory: [{ id: 'c10', timestamp: '2024-04-19T15:20:00Z', amount: 10000, onTime: true, method: 'M-Pesa Ledger' }]
  },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'profiler' | 'chama' | 'predictor' | 'blueprint'>('profiler');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [isDepositing, setIsDepositing] = useState(false);
  const [loanProcessing, setLoanProcessing] = useState(false);
  const [loanResult, setLoanResult] = useState<RiskAssessment | null>(null);

  // Auth Listener
  React.useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setMembers([]);
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Firestore Data Listener
  React.useEffect(() => {
    if (!user) return;

    setLoading(true);
    const q = query(collection(db, 'members'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs: Member[] = [];
      snapshot.forEach((doc) => {
        docs.push(doc.data() as Member);
      });
      
      if (docs.length === 0 && user) {
        // Bootstrap data if empty
        bootstrapData();
      } else {
        setMembers(docs);
        setLoading(false);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'members');
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const bootstrapData = async () => {
    if (!user) return;
    try {
      setLoading(true);
      // 1. Create the admin record first
      const adminRef = doc(db, 'admins', user.uid);
      await setDoc(adminRef, { uid: user.uid, email: user.email });
      
      console.log("Admin registered. Bootstrapping members...");

      // 2. Add template members in a batch
      const batch = writeBatch(db);
      INITIAL_MEMBERS.forEach((m) => {
        const memberRef = doc(db, 'members', m.id);
        batch.set(memberRef, m);
      });
      
      await batch.commit();
      console.log("Maendeleo Governance Bootstrapped.");
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'bootstrap');
    } finally {
      setLoading(false);
    }
  };

  const login = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setSelectedMemberId(null);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };
  
  const selectedMember = useMemo(() => 
    members.find(m => m.id === selectedMemberId) || null
  , [selectedMemberId, members]);

  const handleDeposit = async (memberId: string) => {
    setIsDepositing(true);
    setLoanResult(null);
    try {
      const member = members.find(m => m.id === memberId);
      if (!member) throw new Error("Member not found");

      const now = new Date();
      const isFridayDeadline = now.getDay() === 5 && now.getHours() <= 23 && now.getMinutes() <= 59;
      const onTime = now.getDay() < 5 || isFridayDeadline;
      
      const newRecord: ContributionRecord = {
        id: `new-${Date.now()}`,
        timestamp: now.toISOString(),
        amount: 10000,
        onTime,
        method: 'Treasurer Escrow (Live)'
      };

      const memberRef = doc(db, 'members', memberId);
      await updateDoc(memberRef, {
        contributionHistory: [newRecord, ...member.contributionHistory]
      });

      alert("Contribution Successfully Dispatched to Treasurer Account.");
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `members/${memberId}`);
    } finally {
      setIsDepositing(false);
    }
  };

  const handleApplyLoan = (member: Member) => {
    setLoanProcessing(true);
    setLoanResult(null);
    
    // Simulate "Backend" prediction
    setTimeout(() => {
      const result = calculateHybridRiskScore(member, 50000); // Defaulting to 50k for quick check
      setLoanResult(result);
      setLoanProcessing(false);
    }, 2000);
  };

  // Predictor State
  const [predictorInput, setPredictorInput] = useState({
    income: 60000,
    txFreq: 20,
    utilityReliability: 90,
    smsRecords: 10,
    credit: 700,
    amount: 15000
  });

  // Simulation of the Python Logic in JS
  const predictionResult = useMemo(() => {
    const { income, txFreq, utilityReliability, smsRecords, credit, amount } = predictorInput;
    const lti = amount / income;
    
    // Alternative Weights
    const altSignal = (txFreq * 0.1) + (utilityReliability / 100 * 0.1) + (smsRecords * 0.05);
    const score = (0.4 * (credit / 850)) + (0.4 * altSignal) - (0.2 * lti);
    const approved = score > 0.35;
    
    const reasons = [];
    if (credit < 550) reasons.push("Traditional credit exposure is weak.");
    if (txFreq < 5) reasons.push("Low transaction volume signal.");
    if (utilityReliability < 70) reasons.push("Irregular utility payment history.");
    
    return {
      approved,
      score: score * 100,
      reasons: approved ? "Alternative data indicates a reliable cash-flow pattern." : (reasons.length ? `Rejected: ${reasons.join("; ")}` : "Incomplete alternative signal profile.")
    };
  }, [predictorInput]);

  // Chama Sustainability Forecast (Projected Profits/Losses)
  const sustainabilityData = useMemo(() => {
    const scores = members.map(m => calculateMemberScore(m));
    const avgScore = scores.reduce((acc, s) => acc + s, 0) / (members.length || 1);
    
    // Starting capital simulation
    let currentCapital = 500000; 
    
    return Array.from({ length: 12 }).map((_, i) => {
      const growthFactor = (avgScore / 100) * 0.15; // Based on health
      const riskFactor = (1 - (avgScore / 100)) * 0.05; // Potential default risk
      
      const profit = currentCapital * growthFactor * (1 - riskFactor);
      const losses = currentCapital * riskFactor * (i > 6 ? 1.5 : 1); // Risks compound over time
      currentCapital = currentCapital + profit - losses;

      return {
        month: `Month ${i + 1}`,
        capital: Math.round(currentCapital),
        profit: Math.round(profit),
        losses: Math.round(losses),
        resilience: Math.max(0, Math.min(100, avgScore - (i * 0.5)))
      };
    });
  }, [members]);

  const groupRisk = useMemo(() => {
    const scores = members.map(m => calculateMemberScore(m));
    const min = Math.min(...scores);
    if (min < 40) return { label: 'High Risk', color: 'text-red-500', bg: 'bg-red-50' };
    if (min < 65) return { label: 'Moderate', color: 'text-yellow-600', bg: 'bg-yellow-50' };
    return { label: 'Stable', color: 'text-green-600', bg: 'bg-green-50' };
  }, [members]);

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-white p-12 rounded-[3rem] shadow-2xl shadow-indigo-100 border border-slate-100 text-center"
        >
          <div className="w-20 h-20 bg-indigo-600 rounded-3xl mx-auto flex items-center justify-center shadow-xl shadow-indigo-200 mb-8">
            <Sprout className="text-white w-10 h-10" />
          </div>
          <h1 className="text-3xl font-black text-slate-900 mb-4 tracking-tighter uppercase italic">Maendeleo Portal</h1>
          <p className="text-slate-500 font-medium mb-12">Secure gateway for automated Chama governance & credit scoring.</p>
          
          <button 
            onClick={login}
            className="w-full py-5 bg-slate-900 text-white rounded-2xl font-black text-sm uppercase tracking-[0.2em] shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-3 group"
          >
            Connect Identity
            <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
          
          <p className="mt-8 text-[10px] font-black text-slate-300 uppercase tracking-widest">Powered by Maendeleo AI Engine v1.2</p>
        </motion.div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] font-sans text-slate-900 pb-20">
      {/* Header */}
      <header className="sticky top-0 bg-white/80 backdrop-blur-md border-b border-slate-200 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-indigo-200 shadow-lg">
              <Sprout className="text-white w-6 h-6" />
            </div>
            <div>
               <h1 className="text-lg font-black tracking-tight leading-none uppercase">MAENDELEO GROUP</h1>
               <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Chama Management System</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <nav className="hidden md:flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
              {(['profiler', 'chama', 'predictor', 'blueprint'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab);
                    setSelectedMemberId(null);
                  }}
                  className={cn(
                    "px-4 py-2 rounded-md text-xs font-bold transition-all uppercase tracking-wider",
                    activeTab === tab ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  {tab === 'predictor' ? 'Loan Eligibility' : tab}
                </button>
              ))}
            </nav>
            <div className="h-8 w-[1px] bg-slate-200 hidden md:block" />
            <div className="flex items-center gap-3">
               <div className="text-right hidden sm:block">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Session Active</p>
                  <p className="text-xs font-bold text-slate-900 leading-none">{user.email?.split('@')[0]}</p>
               </div>
               <button 
                 onClick={logout}
                 className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                 title="Logout"
               >
                 <Lock className="w-5 h-5" />
               </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {activeTab === 'profiler' && !selectedMemberId && (
            <motion.div key="profiler" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-12">
              <section>
                <div className="flex items-end justify-between mb-8">
                  <div>
                    <h2 className="text-4xl font-black tracking-tighter mb-2 italic text-indigo-900">Member Directory</h2>
                    <p className="text-slate-500 font-medium max-w-md">Comprehensive list of all members with real-time health scoring.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="px-4 py-2 bg-white border border-slate-200 rounded-xl flex items-center gap-2 shadow-sm">
                      <Users className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-bold">{members.length} Members</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {members.map((member) => (
                    <motion.div 
                      key={member.id} 
                      whileHover={{ scale: 1.02 }}
                      onClick={() => {
                        setSelectedMemberId(member.id);
                        setLoanResult(null);
                      }}
                      className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-xl hover:shadow-indigo-500/10 cursor-pointer transition-all group"
                    >
                      <div className="flex items-start justify-between mb-6">
                        <div className="flex gap-4">
                          <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-black text-lg">{member.name[0]}</div>
                          <div>
                            <h4 className="font-black text-slate-900 leading-tight mb-1 group-hover:text-indigo-600 transition-colors uppercase">{member.name}</h4>
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{member.role}</p>
                          </div>
                        </div>
                        <div className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter", 
                          member.status === 'Active' ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
                        )}>
                          {member.status}
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="flex justify-between items-end">
                           <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Chama Health Score</span>
                           <span className="text-2xl font-black text-indigo-600 tabular-nums">
                             {calculateMemberScore(member).toFixed(0)}
                           </span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                           <div 
                             className="h-full bg-indigo-500 rounded-full" 
                             style={{ width: `${calculateMemberScore(member)}%` }}
                           />
                        </div>
                        
                        <div className="flex flex-wrap gap-2 pt-2">
                           {isLoanEligible(member) ? (
                             <span className="text-[9px] font-black px-2 py-1 bg-emerald-100 text-emerald-700 rounded-lg uppercase tracking-wider flex items-center gap-1">
                               <ShieldCheck className="w-3 h-3" /> Eligible
                             </span>
                           ) : (
                             <span className="text-[9px] font-black px-2 py-1 bg-red-100 text-red-700 rounded-lg uppercase tracking-wider flex items-center gap-1">
                               <AlertTriangle className="w-3 h-3" /> Ineligible
                             </span>
                           )}
                           <span className="text-[9px] font-black px-2 py-1 bg-slate-100 text-slate-600 rounded-lg uppercase tracking-wider">
                             {calculateMembershipDuration(member.joinDate)} Months Member
                           </span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </section>
            </motion.div>
          )}

          {activeTab === 'profiler' && selectedMember && (
            <motion.div key="profile" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} className="max-w-5xl mx-auto">
              <button 
                onClick={() => setSelectedMemberId(null)} 
                className="flex items-center gap-2 text-slate-400 hover:text-indigo-600 font-black text-[10px] uppercase tracking-widest mb-8 transition-colors group"
              >
                <ChevronRight className="w-4 h-4 rotate-180 group-hover:-translate-x-1 transition-transform" /> Back to Directory
              </button>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-1 space-y-6">
                  <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                    <div className="flex flex-col items-center text-center mb-8">
                       <div className="w-24 h-24 rounded-3xl bg-indigo-600 text-white flex items-center justify-center font-black text-4xl mb-4 shadow-xl shadow-indigo-200">
                         {selectedMember.name[0]}
                       </div>
                       <h3 className="text-2xl font-black text-slate-900 uppercase">{selectedMember.name}</h3>
                       <p className="text-indigo-600 font-bold text-xs uppercase tracking-widest mt-1">{selectedMember.role}</p>
                       <div className="mt-4 flex items-center gap-2 px-4 py-1 bg-slate-50 border border-slate-100 rounded-full">
                          <div className={cn("w-2 h-2 rounded-full", selectedMember.status === 'Active' ? "bg-emerald-500" : "bg-red-500")} />
                          <span className="text-[10px] font-black text-slate-500 uppercase">{selectedMember.status}</span>
                       </div>
                    </div>

                    <div className="space-y-4">
                       <div className="p-4 bg-slate-50 rounded-2xl flex items-center gap-4">
                          <Smartphone className="w-5 h-5 text-slate-400" />
                          <div>
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Contact</p>
                            <p className="text-sm font-bold text-slate-700">{selectedMember.contact}</p>
                          </div>
                       </div>
                       <div className="p-4 bg-slate-50 rounded-2xl flex items-center gap-4">
                          <Calendar className="w-5 h-5 text-slate-400" />
                          <div>
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Joined</p>
                            <p className="text-sm font-bold text-slate-700">{new Date(selectedMember.joinDate).toLocaleDateString('en-KE', { dateStyle: 'long' })}</p>
                          </div>
                       </div>
                       <div className="p-4 bg-slate-50 rounded-2xl flex items-center gap-4">
                          <Clock className="w-5 h-5 text-slate-400" />
                          <div>
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Membership Duration</p>
                            <p className="text-sm font-bold text-slate-700">{calculateMembershipDuration(selectedMember.joinDate)} Months</p>
                          </div>
                       </div>
                    </div>
                  </div>
                  
                  <div className="bg-slate-900 p-8 rounded-3xl text-white shadow-xl relative overflow-hidden">
                    <div className="relative z-10">
                      <h4 className="text-xl font-bold mb-6 flex items-center gap-2"><CreditCard className="text-yellow-400 w-5 h-5" /> Assets & Collateral</h4>
                      <div className="space-y-3">
                        {selectedMember.assets.map((asset, i) => (
                          <div key={i} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10">
                             <div className="w-2 h-2 rounded-full bg-indigo-400" />
                             <span className="text-xs font-medium text-slate-300">{asset}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-2 space-y-8">
                  {/* Alternative Data Signals Section */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                     <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                        <div className="p-2 bg-indigo-50 w-fit rounded-xl mb-4">
                           <CreditCard className="w-5 h-5 text-indigo-600" />
                        </div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">M-Pesa Ledger</p>
                        <h5 className="text-lg font-black text-slate-900 leading-none mb-2">{selectedMember.txFreq} Daily Txs</h5>
                        <p className="text-[10px] text-slate-500 font-medium">Avg Value: KES {selectedMember.avgTxValue.toLocaleString()}</p>
                     </div>
                     <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                        <div className="p-2 bg-emerald-50 w-fit rounded-xl mb-4">
                           <Zap className="w-5 h-5 text-emerald-600" />
                        </div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Utility Score</p>
                        <h5 className="text-lg font-black text-slate-900 leading-none mb-2">{selectedMember.utilityReliability}% Reliable</h5>
                        <p className="text-[10px] text-slate-500 font-medium tracking-tight">KPLC & Water Payment History</p>
                     </div>
                     <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                        <div className="p-2 bg-pink-50 w-fit rounded-xl mb-4">
                           <Smartphone className="w-5 h-5 text-pink-600" />
                        </div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Business Records</p>
                        <h5 className="text-lg font-black text-slate-900 leading-none mb-2">{selectedMember.businessSmsVolume} SMS/Day</h5>
                        <p className="text-[10px] text-slate-500 font-medium">Verified SMS Business Logs</p>
                     </div>
                  </div>

                  <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-pink-50 text-pink-600 rounded-2xl flex items-center justify-center">
                          <PiggyBank className="w-6 h-6" />
                        </div>
                        <div>
                           <h4 className="text-xl font-black uppercase text-indigo-950">Deposit Weekly Savings</h4>
                           <p className="text-slate-400 text-xs font-bold uppercase tracking-wider">Required: KES 10,000 / Friday EOD</p>
                        </div>
                      </div>
                      <button 
                        disabled={isDepositing}
                        onClick={() => handleDeposit(selectedMember.id)}
                        className="bg-slate-900 text-white px-8 py-4 rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-slate-200 hover:bg-indigo-600 transition-all flex items-center gap-2 group disabled:opacity-50"
                      >
                        {isDepositing ? (
                          <>
                            <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                            Escrow Processing...
                          </>
                        ) : (
                          <>
                            Send Money
                            <TrendingUp className="w-4 h-4 group-hover:translate-y-[-2px] group-hover:translate-x-[2px] transition-transform" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className={cn("p-8 rounded-3xl border-2 transition-all", 
                    loanResult 
                      ? (loanResult.recommendation === 'Approve' ? "bg-emerald-50/50 border-emerald-100" : loanResult.recommendation === 'Reduce Loan' ? "bg-yellow-50/50 border-yellow-100" : "bg-red-50/50 border-red-100")
                      : (isLoanEligible(selectedMember) ? "bg-emerald-50/50 border-emerald-100" : "bg-red-50/50 border-red-100")
                  )}>
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div>
                        <h4 className="text-xl font-black mb-1 flex items-center gap-2 text-indigo-950">
                          {loanResult 
                            ? (loanResult.recommendation === 'Approve' ? <ShieldCheck className="text-emerald-500" /> : loanResult.recommendation === 'Reduce Loan' ? <Activity className="text-yellow-500" /> : <AlertTriangle className="text-red-500" />)
                            : (isLoanEligible(selectedMember) ? <ShieldCheck className="text-emerald-500" /> : <AlertTriangle className="text-red-500" />)
                          }
                          Hybrid Loan Risk Assessment
                        </h4>
                        <p className="text-slate-500 text-sm font-medium">Model: Maendeleo Ensemble v1.2 (scikit-learn)</p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="text-right">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Health-Adjusted Interest</p>
                          <p className="text-2xl font-black text-indigo-600 leading-none">{calculateInterestRate(calculateMemberScore(selectedMember))}% <span className="text-xs font-bold text-slate-400">/ Cycle</span></p>
                        </div>
                        <button 
                          disabled={!isLoanEligible(selectedMember) || loanProcessing}
                          className={cn("px-8 py-4 rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl transition-all active:scale-95 flex items-center gap-2 min-w-[200px] justify-center",
                            isLoanEligible(selectedMember) && !loanProcessing ? "bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-200" : "bg-white text-slate-400 border border-slate-200 cursor-not-allowed opacity-50"
                          )}
                          onClick={() => handleApplyLoan(selectedMember)}
                        >
                          {loanProcessing ? (
                            <>
                              <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                              Running Prediction...
                            </>
                          ) : (
                            'Apply Loan'
                          )}
                        </button>
                      </div>
                    </div>

                    {loanResult && (
                      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-8 pt-8 border-t border-slate-200/50">
                         <div className="flex flex-col md:flex-row gap-8">
                            <div className="flex-1 space-y-4">
                               <div>
                                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Decision Result</p>
                                  <div className="flex items-center gap-3">
                                     <span className={cn("px-4 py-2 rounded-xl text-lg font-black uppercase italic tracking-tighter",
                                        loanResult.recommendation === 'Approve' ? "bg-emerald-500 text-white" : loanResult.recommendation === 'Reduce Loan' ? "bg-yellow-500 text-white" : "bg-red-500 text-white"
                                     )}>
                                        {loanResult.recommendation === 'Approve' ? 'Approved' : loanResult.recommendation === 'Reduce Loan' ? 'Conditional' : 'Rejected'}
                                     </span>
                                     <div className="flex flex-col">
                                        <span className="text-[10px] font-bold text-slate-400">AI Confidence</span>
                                        <span className="text-xs font-black text-slate-900">{(loanResult.confidence * 100).toFixed(0)}% Certainty</span>
                                     </div>
                                  </div>
                               </div>
                               <div>
                                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Weighted Indicators</p>
                                  <div className="flex flex-wrap gap-2">
                                     {loanResult.factors.map((f, i) => (
                                        <span key={i} className="px-3 py-1 bg-white border border-slate-200 rounded-full text-[10px] font-bold text-slate-600">
                                           {f}
                                        </span>
                                     ))}
                                  </div>
                               </div>
                            </div>
                            <div className="md:w-32 space-y-2">
                               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Risk Index</p>
                               <div className="text-2xl font-black text-slate-900 leading-none">{loanResult.score.toFixed(1)} <span className="text-[10px] font-bold text-slate-400">PTS</span></div>
                               <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mt-2">
                                   <div 
                                     className={cn("h-full rounded-full", loanResult.level === 'High' ? "bg-red-500" : loanResult.level === 'Medium' ? "bg-yellow-500" : "bg-emerald-500")}
                                     style={{ width: `${loanResult.score}%` }} 
                                   />
                               </div>
                            </div>
                         </div>
                      </motion.div>
                    )}

                    {!loanResult && isLoanEligible(selectedMember) && (
                      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="p-4 bg-white/50 rounded-2xl border border-emerald-100">
                          <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-1">Max Borrowing Capacity</p>
                          <p className="text-lg font-black text-slate-900 leading-none">KES 250,000</p>
                        </div>
                        <div className="p-4 bg-white/50 rounded-2xl border border-emerald-100">
                          <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-1">Repayment Estimate @ Max</p>
                          <p className="text-lg font-black text-slate-900 leading-none">KES {(250000 * (1 + calculateInterestRate(calculateMemberScore(selectedMember))/100)).toLocaleString()}</p>
                        </div>
                      </div>
                    )}

                    {!loanResult && !isLoanEligible(selectedMember) && (
                      <div className="mt-6 p-4 bg-white rounded-2xl border border-red-100 flex items-start gap-3 shadow-inner">
                         <div className="w-10 h-10 rounded-xl bg-red-50 flex-shrink-0 flex items-center justify-center">
                            <Info className="w-5 h-5 text-red-500" />
                         </div>
                         <div>
                            <p className="text-xs font-black text-red-700 uppercase mb-1">Reason for Ineligibility</p>
                            <p className="text-xs text-red-600 font-medium italic">{getIneligibilityReason(selectedMember)}</p>
                         </div>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm h-fit">
                      <h4 className="text-lg font-black mb-6 uppercase tracking-tight flex items-center gap-2 text-indigo-900">
                        <History className="w-5 h-5 text-indigo-500" /> Member Loan Record
                      </h4>
                      <div className="space-y-4">
                        {selectedMember.loanHistory.map((loan) => (
                          <div key={loan.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                             <div className="flex justify-between items-start">
                                <div>
                                  <p className="text-lg font-black text-slate-800 tabular-nums">KES {loan.amount.toLocaleString()}</p>
                                  <p className="text-[10px] text-slate-400 font-bold uppercase">{new Date(loan.date).toLocaleDateString()}</p>
                                </div>
                                <span className={cn("text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest",
                                  loan.status === 'Repaid' ? "bg-emerald-100 text-emerald-700" : "bg-indigo-100 text-indigo-700"
                                )}>{loan.status}</span>
                             </div>
                             {loan.status === 'Ongoing' && (
                               <div className="space-y-1.5">
                                 <div className="flex justify-between text-[9px] font-black text-slate-400 uppercase">
                                   <span>Repayment</span>
                                   <span>{loan.repaymentProgress}%</span>
                                 </div>
                                 <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                   <div className="h-full bg-indigo-500" style={{ width: `${loan.repaymentProgress}%` }} />
                                 </div>
                               </div>
                             )}
                          </div>
                        ))}
                        {selectedMember.loanHistory.length === 0 && (
                          <p className="text-xs font-bold text-slate-400 italic text-center py-4">No previous loan records found.</p>
                        )}
                      </div>
                    </div>

                    <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                      <h4 className="text-lg font-black mb-6 uppercase tracking-tight flex items-center gap-2 text-indigo-900">
                        <PiggyBank className="w-5 h-5 text-pink-500" /> Contribution History
                      </h4>
                      <div className="space-y-3">
                         {selectedMember.contributionHistory.map((c) => {
                           const dt = formatDateTime(c.timestamp);
                           return (
                             <div key={c.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-2 group hover:bg-white hover:shadow-md transition-all">
                                <div className="flex items-center justify-between">
                                   <p className="text-sm font-black text-indigo-900 tabular-nums">KES {c.amount.toLocaleString()}</p>
                                   <div className={cn("px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest", 
                                     c.onTime ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
                                   )}>
                                     {c.onTime ? 'Verified Early' : 'Late Delivery'}
                                   </div>
                                </div>
                                <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold uppercase tracking-tighter">
                                   <div className="flex items-center gap-1">
                                      <Calendar className="w-3 h-3" /> {dt.date}
                                   </div>
                                   <div className="flex items-center gap-1">
                                      <Clock className="w-3 h-3" /> {dt.time}
                                   </div>
                                </div>
                                <p className="text-[9px] text-slate-300 italic font-medium">{dt.day} • via {c.method}</p>
                             </div>
                           );
                         })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'chama' && (
            <motion.div key="chama" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
              <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden relative">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 relative z-10">
                   <div>
                      <h3 className="text-2xl font-black text-indigo-950 uppercase italic tracking-tighter">12-Month Financial Velocity</h3>
                      <p className="text-slate-400 text-sm font-medium">Modeling interest yields vs. communal risk factors.</p>
                   </div>
                   <div className="flex items-center gap-4 bg-slate-50 p-2 rounded-2xl border border-slate-100">
                      <div className="px-4 text-center border-r border-slate-200">
                         <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Growth Index</p>
                         <p className="text-lg font-black text-emerald-600">+{((sustainabilityData[11].capital - sustainabilityData[0].capital) / sustainabilityData[0].capital * 100).toFixed(1)}%</p>
                      </div>
                      <div className="px-4 text-center">
                         <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Resilience</p>
                         <p className="text-lg font-black text-indigo-600">{sustainabilityData[0].resilience.toFixed(0)}%</p>
                      </div>
                   </div>
                </div>

                <div className="h-[350px] relative z-10">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={sustainabilityData}>
                      <defs>
                        <linearGradient id="colorCap" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.1}/>
                          <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.1}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="month" hide />
                      <YAxis hide />
                      <Tooltip 
                        contentStyle={{ borderRadius: '24px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px' }}
                        formatter={(value: any) => [`KES ${value.toLocaleString()}`, '']}
                      />
                      <Area type="monotone" dataKey="capital" stroke="#4f46e5" strokeWidth={3} fillOpacity={1} fill="url(#colorCap)" name="Total Capital" />
                      <Area type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorProfit)" name="Gross Yield" />
                      <Area type="monotone" dataKey="losses" stroke="#ef4444" strokeWidth={2} fill="transparent" name="Default Risk" strokeDasharray="5 5" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <div className="flex justify-between mt-6 text-[10px] font-black text-slate-300 uppercase tracking-[0.3em] px-4">
                  <span>Inception</span>
                  <span>Q3 Projection</span>
                  <span>End of Horizon</span>
                </div>
                
                <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-50/50 rounded-full -mr-48 -mt-48 blur-3xl" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-8 bg-slate-900 rounded-[2rem] text-white overflow-hidden relative group">
                  <div className="relative z-10">
                    <h4 className="text-lg font-black mb-6 flex items-center gap-2 uppercase italic tracking-tighter"><Lock className="w-5 h-5 text-indigo-400" /> Sustainability Governance</h4>
                    <ul className="space-y-4">
                      {[
                        { t: 'Interest Tiering', v: '10%–25% based on Vouch Ranking.' },
                        { t: 'Late Penalties', v: 'KES 5,000 for Friday EOD violations.' },
                        { t: 'Interdiction', v: 'Automated asset recovery for 30-day default.' }
                      ].map((item, i) => (
                        <li key={i} className="flex gap-4 group/item">
                           <div className="w-6 h-6 rounded-lg bg-white/10 flex items-center justify-center text-[10px] font-black text-indigo-400 group-hover/item:bg-indigo-500 group-hover/item:text-white transition-colors">0{i+1}</div>
                           <div>
                              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">{item.t}</p>
                              <p className="text-xs font-medium text-slate-200">{item.v}</p>
                           </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="absolute bottom-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full -mb-16 -mr-16 blur-2xl group-hover:bg-indigo-500/20 transition-all" />
                </div>

                <div className="p-8 bg-emerald-50 rounded-[2rem] border border-emerald-100 flex flex-col justify-between">
                   <div>
                    <h4 className="text-lg font-black text-emerald-900 mb-4 uppercase italic tracking-tighter">Communal Asset Buffer</h4>
                    <p className="text-sm text-emerald-700 leading-relaxed font-medium mb-6">
                      With a cumulative {members.reduce((a,b) => a+b.peerVouches, 0)} peer vouches and a 95% punctuality average, the group currently maintains a <b>Strong</b> resilience rating against macroeconomic volatility.
                    </p>
                   </div>
                   <div className="flex items-center gap-2 text-[10px] font-black text-emerald-600 uppercase tracking-widest bg-emerald-100/50 w-fit px-4 py-2 rounded-full">
                      <TrendingUp className="w-4 h-4" /> Healthy Growth Probability: 92%
                   </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'predictor' && (
            <motion.div key="predictor" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm space-y-6">
                <h3 className="text-xl font-bold flex items-center gap-2 text-indigo-950 underline decoration-slate-100"><Zap className="text-indigo-600 w-5 h-5" /> Alternative Credit Simulator</h3>
                <div className="space-y-4">
                  {[
                    { label: 'Weekly Gross Income (KES)', key: 'income', min: 5000, max: 100000, step: 1000 },
                    { label: 'M-Pesa daily Txs', key: 'txFreq', min: 0, max: 50, step: 1 },
                    { label: 'Utility Reliability %', key: 'utilityReliability', min: 0, max: 100, step: 5 },
                    { label: 'Daily Business SMS Records', key: 'smsRecords', min: 0, max: 100, step: 1 },
                    { label: 'Bank Credit Score (If any)', key: 'credit', min: 300, max: 850, step: 1 },
                    { label: 'Requested Loan (KES)', key: 'amount', min: 1000, max: 100000, step: 500 },
                  ].map((field) => (
                    <div key={field.key} className="space-y-2">
                      <div className="flex justify-between text-xs font-bold uppercase text-slate-400">
                        <span>{field.label}</span>
                        <span className="text-indigo-600">{predictorInput[field.key as keyof typeof predictorInput].toLocaleString()}</span>
                      </div>
                      <input 
                        type="range"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={predictorInput[field.key as keyof typeof predictorInput]}
                        onChange={(e) => setPredictorInput({...predictorInput, [field.key]: parseInt(e.target.value)})}
                        className="w-full h-1.5 bg-slate-100 rounded-full appearance-none accent-indigo-600"
                      />
                    </div>
                  ))}
                </div>
                <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                   <div className="flex items-center gap-3 text-indigo-700">
                      <Info className="w-5 h-5 flex-shrink-0" />
                      <p className="text-[11px] font-medium leading-relaxed italic">
                        This interface uses a <b>Random Forest Ensemble</b> trained on over 1,000 simulated alternative data profiles.
                      </p>
                   </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className={cn(
                  "p-8 rounded-3xl border-2 transition-all duration-500 flex flex-col items-center justify-center min-h-[300px] text-center",
                  predictionResult.approved ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"
                )}>
                  {predictionResult.approved ? (
                    <ShieldCheck className="w-20 h-20 text-emerald-500 mb-4" />
                  ) : (
                    <AlertTriangle className="w-20 h-20 text-red-500 mb-4" />
                  )}
                  <h4 className={cn("text-3xl font-black mb-2", predictionResult.approved ? "text-emerald-700" : "text-red-700")}>
                    {predictionResult.approved ? 'APPROVED' : 'REJECTED'}
                  </h4>
                  <p className="text-slate-500 text-sm mb-6 max-w-[200px]">
                    Confidence Level: <span className="font-bold">{predictionResult.score.toFixed(1)}%</span>
                  </p>
                  
                  <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden mb-6">
                    <motion.div 
                      initial={{ width: 0 }} 
                      animate={{ width: `${predictionResult.score}%` }} 
                      className={cn("h-full", predictionResult.approved ? "bg-emerald-500" : "bg-red-500")}
                    />
                  </div>

                  <div className="p-4 bg-white rounded-2xl shadow-sm border border-slate-100 w-full">
                     <p className="text-[11px] font-black uppercase text-slate-400 mb-1">AI Explanation</p>
                     <p className="text-xs text-slate-600 leading-relaxed font-medium">{predictionResult.reasons}</p>
                  </div>
                </div>

                <div className="bg-slate-900 rounded-2xl p-6 text-white shadow-lg overflow-hidden relative">
                   <div className="relative z-10 space-y-4">
                      <h5 className="font-bold flex items-center gap-2"><Smartphone className="w-4 h-4 text-indigo-400" /> Edge Intelligence</h5>
                      <p className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-black">Architecture</p>
                      <ul className="text-xs space-y-2 text-slate-300">
                        <li className="flex gap-2"><div className="w-1 h-1 bg-indigo-400 rounded-full mt-1.5 flex-shrink-0"/> Model: scikit-learn Logistic/Forest</li>
                        <li className="flex gap-2"><div className="w-1 h-1 bg-indigo-400 rounded-full mt-1.5 flex-shrink-0"/> Privacy: Locally Sanitized Input</li>
                        <li className="flex gap-2"><div className="w-1 h-1 bg-indigo-400 rounded-full mt-1.5 flex-shrink-0"/> Sync: Metadata Only transmission</li>
                      </ul>
                   </div>
                   <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-indigo-500/20 blur-[50px] rounded-full" />
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'blueprint' && (
            <motion.div key="blueprint" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl mx-auto space-y-16 py-12">
              <div className="space-y-4 text-center max-w-2xl mx-auto">
                <h2 className="text-6xl font-black text-slate-900 leading-[0.9] tracking-tighter italic">Decentralized <span className="text-indigo-600 underline decoration-8 decoration-indigo-100 underline-offset-[-8px]">Trust</span></h2>
                <p className="text-xl text-slate-400 font-medium font-sans">Quantifying the cost of communal shame for credit intelligence.</p>
              </div>
              <div className="grid gap-8">
                {[
                  { t: 'Behavioral Liquidity', d: 'Tracking M-Pesa overdraft patterns reveals short-term stress before banks ever notice.', i: <CreditCard className="w-8 h-8"/> },
                  { t: 'The Vouch Engine', d: 'Peer-to-peer collateral mapping. A member is only as strong as the 5 people willing to back them.', i: <Users className="w-8 h-8"/> },
                  { t: 'Asset Interdiction', d: 'Real-time smart contract integration for informal asset recovery protocols.', i: <TrendingUp className="w-8 h-8"/> }
                ].map((x, i) => (
                  <div key={x.t} className="flex flex-col md:flex-row gap-8 p-10 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm transition-all hover:shadow-xl group">
                    <div className="p-6 bg-indigo-50 rounded-[1.8rem] text-indigo-600 h-fit group-hover:bg-indigo-600 group-hover:text-white transition-colors">{x.i}</div>
                    <div className="space-y-3">
                       <p className="text-[10px] font-black text-indigo-200 uppercase tracking-[0.3em]">Module 0{i+1}</p>
                       <h4 className="text-2xl font-black text-slate-900 uppercase italic tracking-tighter leading-none">{x.t}</h4>
                       <p className="text-base text-slate-400 font-medium leading-relaxed max-w-md">{x.d}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-16 bg-indigo-600 rounded-[3rem] text-white text-center shadow-2xl relative overflow-hidden">
                 <div className="relative z-10">
                   <Lock className="w-16 h-16 mx-auto mb-8 text-indigo-300 drop-shadow-lg" />
                   <h3 className="text-4xl font-black mb-4 uppercase italic">Zero Trust Communal Lending</h3>
                   <p className="text-indigo-100 text-lg font-medium max-w-lg mx-auto mb-10 leading-relaxed">Our protocol ensures every KES lent is backed by social capital and physical collateral, making default a structural impossibility.</p>
                   <div className="text-[10px] font-black uppercase tracking-[0.4em] text-indigo-300 bg-white/10 py-3 rounded-full border border-white/10 max-w-xs mx-auto backdrop-blur-md">MAENDELEO CORE V1</div>
                 </div>
                 <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl animate-pulse" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}


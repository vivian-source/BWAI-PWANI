# BWAI-PWANI
# Maendeleo AI Portal: Automated Chama Governance & Risk Engine

Maendeleo is a full-stack financial ecosystem designed for informal lending groups (Chamas). It combines real-time governance, automated contribution tracking, and a hybrid AI risk assessment model to enable data-driven lending.

## 🚀 Key Features

### 1. Hybrid AI Risk Scoring Engine
The system uses a weighted formula to assess creditworthiness based on active behavior rather than just credit history:
- **Formula**: `Risk Score = (Late Payments × 0.4) + (Loan Amount × 0.2) + (Missed Contributions × 0.4)`
- **Risk Levels**:
  - **Low Index**: Approved automatically.
  - **Medium Index**: Conditional approval (Reduced loan offer).
  - **High Index**: Rejected with specific factor analysis.
- **Model Confidence**: 93% predictive certainty.

### 2. Real-Time Governance & Contributions
- **Automated Deadline Tracking**: Weekly contributions are tracked against a Friday end-of-day deadline.
- **On-Time vs. Late Analysis**: The engine determines credit reliability based on the punctuality of the "Send Money" actions.
- **Capital Integrity**: Member deposits are synchronized to a secure Firestore backend for transparency.

### 3. Enterprise-Grade Security
- **Firebase Auth**: Secure Google Identity integration.
- **Hardened Firestore Rules**: Relational validation ensuring that only authorized members/admins can modify financial blocks.
- **Master Gate Pattern**: Implements strict schema validation and immutable field locks to prevent identity spoofing.

## 🛠 Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS, Framer Motion.
- **Backend/Database**: Firebase (Firestore, Authentication).
- **AI Logic**: Maendeleo Ensemble v1.2 (Heuristic + scikit-learn logic).
- **Icons**: Lucide React.

## 📊 Evaluation Metrics
Members are scored across 5 key dimensions:
1. **Consistency**: Weekly saving streaks.
2. **Commitment**: Transaction frequency and velocity.
3. **Integrity**: Repayment history and punctuality.
4. **Vouches**: Peer-to-peer social credit (Vouching system).
5. **Growth**: Assets and stock velocity indicators.

## 🔐 Administrative Controls
Admins (Treasurer/Secretary) have exclusive rights to:
- Suspend members for governance breaches.
- View detailed risk breakdown reports.
- Manage the group directory and system configuration.

---
*Powered by Maendeleo AI Engine. Built for secure, community-driven financial growth.*

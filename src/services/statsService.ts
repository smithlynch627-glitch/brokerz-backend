import { formatUnits, formatEther } from 'viem';
import { brkzContract, brkzSaleContract, brokerzHomesContract } from '../chain.js';
import { cached } from '../cache.js';
import { config } from '../config.js';
import { getEthUsdPrice } from './priceService.js';

const TOTAL_SUPPLY_AT_DEPLOY = 500_000_000n * 10n ** 18n;

export interface StatsResponse {
  brkz: {
    totalSupply: string;
    totalSupplyFormatted: number;
    totalBurned: string;
    totalBurnedFormatted: number;
    circulatingSupply: string;
    circulatingSupplyFormatted: number;
  };
  sale: {
    remainingInPool: string;
    remainingInPoolFormatted: number;
    pricePerTokenWei: string;
    pricePerTokenEth: number;
    pricePerTokenUsd: number | null;
    maxPurchasePerWallet: number;
  };
  pricing: {
    ethUsdPrice: number | null;
    fdvEth: number;
    fdvUsd: number | null;
  };
  homes: {
    totalMinted: number;
    maxSupply: number;
    remaining: number;
    percentMinted: number;
    soldOut: boolean;
    maxPerWallet: number;
    teamReserve: number;
    teamMinted: number;
    teamMintFinalized: boolean;
    publicSupply: number;
    publicMinted: number;
    publicRemaining: number;
    publicPercentMinted: number;
  };
  fetchedAt: number;
}

async function computeStats(): Promise<StatsResponse> {
  const [totalSupply, remainingInPool, pricePerToken, maxPurchasePerWallet, totalMinted, maxSupply, maxPerWallet, teamReserve, teamMintedRaw, teamMintFinalized, ethUsdPrice] =
    await Promise.all([
      brkzContract.read.totalSupply(),
      brkzSaleContract.read.remainingInventory(),
      brkzSaleContract.read.pricePerToken(),
      brkzSaleContract.read.maxPurchasePerWallet(),
      brokerzHomesContract.read.totalMinted(),
      brokerzHomesContract.read.MAX_SUPPLY(),
      brokerzHomesContract.read.MAX_PER_WALLET(),
      brokerzHomesContract.read.TEAM_RESERVE(),
      brokerzHomesContract.read.teamMinted(),
      brokerzHomesContract.read.teamMintFinalized(),
      getEthUsdPrice(),
    ]);

  const totalBurned = TOTAL_SUPPLY_AT_DEPLOY - totalSupply;
  const circulatingSupply = totalSupply - remainingInPool;

  const mintedNum = Number(totalMinted);
  const maxSupplyNum = Number(maxSupply);

  // The public allocation is everything not held back for the team. If the
  // reserve is closed early the unused remainder rolls into the public pool.
  const teamReserveNum = Number(teamReserve);
  const teamMintedNum = Number(teamMintedRaw);
  const publicSupply = teamMintFinalized ? maxSupplyNum - teamMintedNum : maxSupplyNum - teamReserveNum;
  const publicMinted = mintedNum - teamMintedNum;

  const pricePerTokenEth = Number(formatEther(pricePerToken));
  const pricePerTokenUsd = ethUsdPrice !== null ? pricePerTokenEth * ethUsdPrice : null;
  const fdvEth = pricePerTokenEth * 500_000_000;
  const fdvUsd = ethUsdPrice !== null ? fdvEth * ethUsdPrice : null;

  return {
    brkz: {
      totalSupply: totalSupply.toString(),
      totalSupplyFormatted: Number(formatUnits(totalSupply, 18)),
      totalBurned: totalBurned.toString(),
      totalBurnedFormatted: Number(formatUnits(totalBurned, 18)),
      circulatingSupply: circulatingSupply.toString(),
      circulatingSupplyFormatted: Number(formatUnits(circulatingSupply, 18)),
    },
    sale: {
      remainingInPool: remainingInPool.toString(),
      remainingInPoolFormatted: Number(formatUnits(remainingInPool, 18)),
      pricePerTokenWei: pricePerToken.toString(),
      pricePerTokenEth,
      pricePerTokenUsd,
      maxPurchasePerWallet: Number(maxPurchasePerWallet),
    },
    pricing: {
      ethUsdPrice,
      fdvEth,
      fdvUsd,
    },
    homes: {
      totalMinted: mintedNum,
      maxSupply: maxSupplyNum,
      remaining: maxSupplyNum - mintedNum,
      percentMinted: maxSupplyNum > 0 ? (mintedNum / maxSupplyNum) * 100 : 0,
      soldOut: mintedNum >= maxSupplyNum,
      maxPerWallet: Number(maxPerWallet),
      teamReserve: teamReserveNum,
      teamMinted: teamMintedNum,
      teamMintFinalized: Boolean(teamMintFinalized),
      publicSupply,
      publicMinted,
      publicRemaining: Math.max(0, publicSupply - publicMinted),
      publicPercentMinted: publicSupply > 0 ? (publicMinted / publicSupply) * 100 : 0,
    },
    fetchedAt: Date.now(),
  };
}

export async function getStats(): Promise<StatsResponse> {
  return cached('stats', config.statsRefreshMs, computeStats);
}

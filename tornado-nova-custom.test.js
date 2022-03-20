const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe.only('Custom test', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    const merkleTreeWithHistory = await deploy(
        'MerkleTreeWithHistoryMock',
        MERKLE_TREE_HEIGHT,
        hasher.address,
      )
      await merkleTreeWithHistory.initialize()
  

    return { merkleTreeWithHistory, tornadoPool, token, proxy, omniBridge, amb, gov, multisig }
  }

  it('should deposit, transact and withdraw', async function () {
    const { merkleTreeWithHistory, tornadoPool, token, omniBridge } = await loadFixture(fixture)

    tx = await merkleTreeWithHistory.insert(toFixedHex(123), toFixedHex(456))
    txReceipt = await tx.wait()
    console.log("Gas for insert a pair of leaves: ", txReceipt.gasUsed.toString())

    const aliceKeypair = new Keypair() // contains private and public keys

    // Alice deposits into tornado pool
    const aliceDepositAmount = utils.parseEther('0.08')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })
    await transaction({ tornadoPool, outputs: [aliceDepositUtxo] })

    // Alice withdraws a part of her funds from the shielded pool
    const aliceWithdrawAmount = utils.parseEther('0.05')
    const aliceEthAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({ amount: aliceDepositAmount.sub(aliceWithdrawAmount), keypair: aliceKeypair })
    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: aliceEthAddress,
    })

    const l2Balance = await token.balanceOf(aliceEthAddress)
    console.log("recipient balance:               ", l2Balance.toString())
    expect(l2Balance).to.be.equal(aliceWithdrawAmount)

    const poolBalance = await token.balanceOf(tornadoPool.address)
    console.log("Pool Balance:                    ", poolBalance.toString())
    expect(poolBalance).to.be.equal(aliceDepositAmount.sub(aliceWithdrawAmount))

    const bridgeBalance = await token.balanceOf(omniBridge.address)
    console.log("Bridge Balance:                  ", bridgeBalance.toString())
    expect(bridgeBalance).to.be.equal("0")
  })
})

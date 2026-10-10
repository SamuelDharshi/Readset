// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract LendingPool {
    address public owner;                          // slot 0
    uint256 public reserved;                       // slot 1
    mapping(address => uint256) public balances;   // slot 2
    mapping(address => uint256) public debt;       // slot 3
    uint256 public totalDeposits;                  // slot 4
    uint256 public totalBorrowed;                  // slot 5

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
    }
}
